/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByProps, onceReady, wreq } from "@vencord/types/webpack";
import { FluxDispatcher, UserStore } from "@vencord/types/webpack/common";
import type { ButecoIceServer, ButecoResult } from "shared/buteco";

import { isButecoPublishing } from "./publishState";
import { findRoomStream, getButecoWebState, subscribeButecoWeb } from "./webState";

/**
 * Viewer "nativo": em vez de um tile próprio, injeta participantes sintéticos
 * do tipo STREAM no ChannelRTCStore do Discord. A UI nativa (grade, botão
 * Watch, player em foco, filme-strip, controles) passa a existir sozinha; o
 * vídeo do SFU do Buteco entra por cima do tile em foco via WHEP.
 *
 * Fontes de stream (uma por pessoa compartilhando):
 * - a sala em que já estamos (estado da sala);
 * - qualquer sala aberta do lobby com tela ao vivo, sem precisar entrar nela.
 *   Só viram tile se quem compartilha estiver na mesma call de voz do Discord.
 *
 * O vídeo só é puxado quando o usuário clica em Watch (entrando na sala nesse
 * momento, se ainda não estiver nela). Tudo é revertido quando a fonte some.
 */

const VIDEO_ID = "vc-buteco-native-video";

/** Tipos de participante do Discord (`lp`): STREAM = 0, USER = 2, ACTIVITY = 3. */
const PARTICIPANT_STREAM = 0;

const RETRY_MS = 4000;
const MAX_RETRIES = 6;

interface Source {
    discordUserId: string;
    siteUserId: string;
    displayName: string;
    roomId: string;
    /** Já estamos dentro da sala onde essa tela está. */
    joined: boolean;
    stream: any;
    participant: any;
}

interface Desired {
    siteUserId: string;
    displayName: string;
    roomId: string;
    joined: boolean;
}

const sources = new Map<string, Source>();

let origRtc: {
    getParticipants: any;
    getFilteredParticipants: any;
    getStreamParticipants: any;
    getParticipant: any;
} | null = null;
let origStreams: { getActiveStreamForApplicationStream: any; getActiveStreamForStreamKey: any } | null = null;
let origCollectionGetParticipant: { collection: any; original: any } | null = null;

/** Quem o usuário está assistindo (clicou em Watch). */
let watchedUserId: string | null = null;
/** Sala em que entramos sozinhos por causa de um Watch; saímos ao parar de assistir. */
let autoJoinedRoomId: string | null = null;
let lobbyRequested = false;
/** Último tile selecionado que já tratamos (evita repetir o pedido a cada tick). */
let lastAutoWatchId: string | null = null;

let pc: RTCPeerConnection | null = null;
let mediaStream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempts = 0;
let starting = false;
const debugLog: string[] = [];

function note(message: string) {
    if (debugLog[debugLog.length - 1]?.endsWith(message)) return;
    debugLog.push(`${new Date().toISOString().slice(11, 23)} ${message}`);
    if (debugLog.length > 60) debugLog.shift();
}

// Handle de diagnóstico: __butecoViewer.pc.getStats()
(globalThis as any).__butecoViewer = {
    get log() {
        return debugLog;
    },
    get pc() {
        return pc;
    },
    get video() {
        return video;
    },
    get installed() {
        return sources.size > 0;
    },
    get sources() {
        return [...sources.values()].map(({ discordUserId, displayName, roomId, joined }) => ({
            discordUserId,
            displayName,
            roomId,
            joined
        }));
    },
    get watching() {
        return watchedUserId;
    }
};

function getVoiceChannel(): { channelId: string; guildId: string | null } | null {
    const selected = findByProps("getVoiceChannelId");
    const channelId = selected?.getVoiceChannelId?.();
    if (!channelId) return null;

    const channelStore = findByProps("getChannel", "getDMFromUserId");
    const guildId = channelStore?.getChannel?.(channelId)?.guild_id ?? null;
    return { channelId, guildId };
}

/**
 * A sala do Buteco usa os ids do SITE (Better Auth), não os do Discord.
 * - Para nós mesmos: comparamos com o id do usuário logado no site.
 * - Para os outros: casamos o displayName com os membros da call (username,
 *   globalName ou nick), que é a única ponte disponível no payload. Primeiro
 *   por igualdade; depois ignorando símbolos/emoji, só se o resultado for único.
 */
function resolveDiscordUserId(siteId: string, displayName: string): string | null {
    const self = UserStore.getCurrentUser();
    if (self && siteId === getButecoWebState().status.user?.id) return self.id;

    const channel = getVoiceChannel();
    if (!channel) return null;

    const channelStore = findByProps("getChannel", "getDMFromUserId");
    const voiceStates = findByProps("getVoiceStatesForChannel");
    const channelObject = channelStore?.getChannel?.(channel.channelId);
    const entries = (channelObject ? voiceStates?.getVoiceStatesForChannel?.(channelObject) : null) as
        Array<{ voiceState?: { userId?: string }; nick?: string | null }> | null | undefined;
    if (!entries?.length) return null;

    const candidates = entries
        .map(entry => {
            const userId = entry.voiceState?.userId;
            const user = userId ? (UserStore.getUser(userId) as any) : null;
            return userId && user ? { userId, names: [user.username, user.globalName, entry.nick] } : null;
        })
        .filter((candidate): candidate is { userId: string; names: Array<string | null | undefined> } => !!candidate);

    const exact = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();
    const loose = (value: string | null | undefined) => (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

    for (const [normalize, label] of [
        [exact, "exato"],
        [loose, "aproximado"]
    ] as const) {
        const target = normalize(displayName);
        if (!target) continue;
        const matches = candidates.filter(candidate => candidate.names.some(name => normalize(name) === target));
        if (matches.length === 1) return matches[0].userId;
        if (matches.length > 1) {
            note(`nome ambíguo (${label}): "${displayName}" casa com ${matches.length} membros da call`);
            return null;
        }
    }

    // Quem compartilha pode simplesmente não estar nesta call: não é erro.
    return null;
}

/**
 * Classe da coleção interna de participantes do ChannelRTCStore. Depois de cada
 * atualização o store revalida a seleção com `collection.getParticipant(id)`
 * (não com o getter do store); sem o nosso participante ali, a seleção do
 * player volta para "nenhuma" em poucos ms.
 */
function findParticipantCollection(): any {
    if (!wreq) return null;
    for (const [id, factory] of Object.entries<any>(wreq.m)) {
        let source = "";
        try {
            source = factory.toString();
        } catch {
            continue;
        }
        if (
            source.length < 60000 &&
            source.includes("updateParticipantPoppedOut") &&
            source.includes("getParticipant(") &&
            !source.includes("CHANNEL_RTC_SELECT_PARTICIPANT")
        ) {
            try {
                const exported = wreq(id);
                const cls = exported?.Ay ?? exported?.default;
                if (cls?.prototype?.getParticipant) return cls;
            } catch {
                // módulo que não carrega: segue procurando
            }
        }
    }
    return null;
}

function emitStoreChanges() {
    try {
        findByProps("getStreamParticipants")?.emitChange?.();
        findByProps("getStreamForUser")?.emitChange?.();
    } catch {
        // um subscriber quebrado não deve impedir a injeção
    }
}

function sourceByParticipantId(id: string): Source | undefined {
    for (const source of sources.values()) if (source.participant.id === id) return source;
    return undefined;
}

function sourceByStreamKey(key: string): Source | undefined {
    for (const source of sources.values()) if (source.stream.streamKey === key) return source;
    return undefined;
}

/** Patcha os stores (uma vez), para todas as fontes. */
function ensurePatched(): boolean {
    const rtc = findByProps("getStreamParticipants");
    const streams = findByProps("getStreamForUser");
    if (!rtc || !streams) return false;

    if (!origRtc) {
        origRtc = {
            getParticipants: rtc.getParticipants,
            getFilteredParticipants: rtc.getFilteredParticipants,
            getStreamParticipants: rtc.getStreamParticipants,
            getParticipant: rtc.getParticipant
        };
        const originals = origRtc;
        const inject = (list: any[] | undefined, channelId: string) => {
            const items = list ?? [];
            const extra = [...sources.values()]
                .filter(source => source.stream.channelId === channelId)
                .map(source => source.participant)
                .filter(participant => !items.some(item => item.id === participant.id));
            return extra.length ? [...items, ...extra] : items;
        };

        rtc.getParticipants = function (channelId: string) {
            return inject(originals.getParticipants.call(this, channelId), channelId);
        };
        rtc.getFilteredParticipants = function (channelId: string) {
            return inject(originals.getFilteredParticipants.call(this, channelId), channelId);
        };
        rtc.getStreamParticipants = function (channelId: string) {
            return inject(originals.getStreamParticipants.call(this, channelId), channelId);
        };
        rtc.getParticipant = function (channelId: string, id: string) {
            return sourceByParticipantId(id)?.participant ?? originals.getParticipant.call(this, channelId, id);
        };
    }

    if (!origStreams) {
        origStreams = {
            getActiveStreamForApplicationStream: streams.getActiveStreamForApplicationStream,
            getActiveStreamForStreamKey: streams.getActiveStreamForStreamKey
        };
        const originals = origStreams;
        streams.getActiveStreamForApplicationStream = function (stream: any) {
            for (const source of sources.values()) if (source.stream === stream) return stream;
            return originals.getActiveStreamForApplicationStream.call(this, stream);
        };
        streams.getActiveStreamForStreamKey = function (key: string) {
            return sourceByStreamKey(key)?.stream ?? originals.getActiveStreamForStreamKey.call(this, key);
        };
    }

    if (!origCollectionGetParticipant) {
        const collection = findParticipantCollection();
        if (collection) {
            const original = collection.prototype.getParticipant;
            origCollectionGetParticipant = { collection, original };
            collection.prototype.getParticipant = function (id: string) {
                const source = sourceByParticipantId(id);
                if (source && this.channelId === source.stream.channelId) return source.participant;
                return original.call(this, id);
            };
        }
    }

    return true;
}

function unpatch() {
    const rtc = findByProps("getStreamParticipants");
    const streams = findByProps("getStreamForUser");

    if (origCollectionGetParticipant) {
        origCollectionGetParticipant.collection.prototype.getParticipant = origCollectionGetParticipant.original;
        origCollectionGetParticipant = null;
    }
    if (rtc && origRtc) {
        rtc.getParticipants = origRtc.getParticipants;
        rtc.getFilteredParticipants = origRtc.getFilteredParticipants;
        rtc.getStreamParticipants = origRtc.getStreamParticipants;
        rtc.getParticipant = origRtc.getParticipant;
    }
    if (streams && origStreams) {
        streams.getActiveStreamForApplicationStream = origStreams.getActiveStreamForApplicationStream;
        streams.getActiveStreamForStreamKey = origStreams.getActiveStreamForStreamKey;
    }
    origRtc = null;
    origStreams = null;
}

/** Sai do player em foco se ele estiver no stream dessa fonte. */
function deselectIfSelected(source: Source) {
    try {
        const rtc = findByProps("getStreamParticipants");
        const { channelId } = source.stream;
        if (rtc?.getSelectedParticipantId?.(channelId) === source.participant.id) {
            findByProps("selectParticipant")?.selectParticipant?.(channelId, null);
        }
    } catch {
        // sem seleção para limpar
    }
}

function addSource(discordUserId: string, desired: Desired, channelId: string, guildId: string | null): boolean {
    if (!ensurePatched()) return false;

    const user = UserStore.getUser(discordUserId);
    if (!user) return false;

    // O Discord parseia a chave: `guild:<guildId>:<channelId>:<ownerId>` ou
    // `call:<channelId>:<ownerId>` (DM). Outro formato quebra o player nativo.
    const streamKey = guildId ? `guild:${guildId}:${channelId}:${discordUserId}` : `call:${channelId}:${discordUserId}`;

    const stream = {
        streamKey,
        channelId,
        guildId,
        ownerId: discordUserId,
        rtcServerId: "0",
        rtcRegion: "brazil",
        viewerIds: [],
        paused: false,
        state: "CONNECTING",
        streamType: "guild",
        isGuildStream: true,
        isScreenshare: true,
        previewURL: null,
        getMediaEngineConnectionId: () => "buteco-native"
    };

    const voiceStates = findByProps("getVoiceState");
    const participant = {
        type: PARTICIPANT_STREAM,
        id: streamKey,
        user,
        userNick: desired.displayName,
        voiceState: voiceStates?.getVoiceState?.(guildId, discordUserId),
        speaking: false,
        soundsharing: false,
        ringing: false,
        localVideoDisabled: false,
        isPoppedOut: false,
        stream
    };

    sources.set(discordUserId, {
        discordUserId,
        siteUserId: desired.siteUserId,
        displayName: desired.displayName,
        roomId: desired.roomId,
        joined: desired.joined,
        stream,
        participant
    });
    note(
        `tile instalado: ${desired.displayName} (sala ${desired.roomId.slice(0, 8)}, ${desired.joined ? "dentro" : "lobby"})`
    );
    return true;
}

function removeSource(discordUserId: string) {
    const source = sources.get(discordUserId);
    if (!source) return;

    deselectIfSelected(source);
    sources.delete(discordUserId);
    note(`tile removido: ${source.displayName}`);

    if (watchedUserId === discordUserId) {
        watchedUserId = null;
        cancelRetry();
        stopPlayback();
        leaveAutoJoinedRoom();
    }
}

/** Todos os tiles do usuário (o de avatar e o do stream falso têm o mesmo atributo). */
function tilesOf(userId: string): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(`[data-selenium-video-tile="${userId}"]`)];
}

/** O tile do NOSSO stream: o que tem o botão Watch (o de avatar não tem). */
function isStreamTile(tile: HTMLElement): boolean {
    return /watch/i.test(tile.textContent || "");
}

/**
 * Onde o vídeo deve ficar: no player em foco (tile grande) ou, minimizado, no
 * próprio tile da grade (preview ao vivo, como o stream nativo).
 */
function findWatchTarget(userId: string): { tile: HTMLElement; focused: boolean } | null {
    const tiles = tilesOf(userId);
    const focused = tiles.find(tile => tile.getBoundingClientRect().width > 600);
    if (focused) return { tile: focused, focused: true };

    const grid = tiles.find(isStreamTile);
    return grid ? { tile: grid, focused: false } : null;
}

function removeVideo() {
    video?.remove();
    video = null;
}

function injectVideo(stream: MediaStream) {
    const target = watchedUserId ? findWatchTarget(watchedUserId) : null;
    if (!target) {
        removeVideo();
        return;
    }

    const fit = target.focused ? "contain" : "cover";
    if (video && document.contains(video) && video.parentElement === target.tile) {
        if (video.srcObject !== stream) video.srcObject = stream;
        video.style.objectFit = fit;
        return;
    }

    // Mesmo elemento ao mudar de tile: o vídeo (e o áudio) não reinicia.
    if (!video) {
        video = document.createElement("video");
        video.id = VIDEO_ID;
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = stream;
    }
    video.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};background:#000;z-index:5;pointer-events:none;`;
    target.tile.style.position = "relative";
    target.tile.appendChild(video);

    const element = video;
    void element.play().catch(() => {
        element.muted = true;
        void element.play().catch(() => {});
    });
}

function scheduleRetry(userId: string) {
    if (retryTimer || retryAttempts >= MAX_RETRIES) return;
    retryTimer = setTimeout(
        () => {
            retryTimer = null;
            if (watchedUserId !== userId) return;
            retryAttempts++;
            sync();
        },
        RETRY_MS * (retryAttempts + 1)
    );
}

function cancelRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryAttempts = 0;
}

async function startPlayback(userId: string) {
    if (starting) return;
    starting = true;
    try {
        await startPlaybackUnsafe(userId);
    } catch (error) {
        note(`startPlayback erro: ${String((error as Error)?.stack ?? error).slice(0, 300)}`);
        stopPlayback();
        scheduleRetry(userId);
    } finally {
        starting = false;
    }
}

async function startPlaybackUnsafe(userId: string) {
    if (pc) return;
    note("startPlayback");

    const ice = (await VesktopNative.buteco.web.ice()) as ButecoResult<ButecoIceServer[]>;
    if (!ice.ok || watchedUserId !== userId) {
        note(`ice falhou/assistindo mudou (ok=${ice.ok}, assistindo=${watchedUserId})`);
        scheduleRetry(userId);
        return;
    }

    const connection = new RTCPeerConnection({ iceServers: ice.value, bundlePolicy: "max-bundle" });
    pc = connection;
    const stream = new MediaStream();
    mediaStream = stream;

    const videoTransceiver = connection.addTransceiver("video", { direction: "recvonly" });
    const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs;
    if (codecs?.length && videoTransceiver.setCodecPreferences) {
        const preferred = codecs.filter(codec => /H264|VP8/i.test(codec.mimeType));
        if (preferred.length) videoTransceiver.setCodecPreferences(preferred);
    }
    connection.addTransceiver("audio", { direction: "recvonly" });

    connection.ontrack = event => {
        stream.addTrack(event.track);
        injectVideo(stream);
    };

    connection.onconnectionstatechange = () => {
        note(`pc ${connection.connectionState}`);
        if (connection.connectionState === "failed") {
            stopPlayback();
            scheduleRetry(userId);
        }
    };

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    const sdp = connection.localDescription?.sdp;
    if (!sdp || pc !== connection) {
        stopPlayback();
        scheduleRetry(userId);
        return;
    }

    const answer = (await VesktopNative.buteco.web.whep(sdp)) as ButecoResult<{ sdp: string }>;
    if (pc !== connection) return;
    if (!answer.ok || !answer.value?.sdp) {
        note(`whep falhou: ${JSON.stringify(answer.ok ? "sem sdp" : answer.error).slice(0, 200)}`);
        stopPlayback();
        scheduleRetry(userId);
        return;
    }

    await connection.setRemoteDescription({ type: "answer", sdp: answer.value.sdp });
    cancelRetry();
}

function stopPlayback() {
    pc?.close();
    pc = null;
    mediaStream = null;
    removeVideo();
}

function leaveAutoJoinedRoom() {
    const roomId = autoJoinedRoomId;
    autoJoinedRoomId = null;
    if (!roomId) return;

    // Nunca derruba uma transmissão nossa só porque paramos de assistir.
    if (getButecoWebState().room?.roomId === roomId && !isButecoPublishing()) {
        note(`saindo da sala ${roomId.slice(0, 8)} (entrada automática)`);
        void VesktopNative.buteco.web.leaveRoom();
    }
}

/** O usuário clicou em Watch: entra na sala (se preciso) e começa a puxar o vídeo. */
async function requestWatch(source: Source) {
    if (watchedUserId && watchedUserId !== source.discordUserId) {
        cancelRetry();
        stopPlayback();
    }
    watchedUserId = source.discordUserId;
    cancelRetry();

    if (source.joined) {
        void startPlayback(source.discordUserId);
        return;
    }

    const current = getButecoWebState().room;
    if (current && current.roomId !== source.roomId) {
        if (isButecoPublishing()) {
            note("não troca de sala: você está transmitindo");
            watchedUserId = null;
            return;
        }
        await VesktopNative.buteco.web.leaveRoom();
    }

    autoJoinedRoomId = source.roomId;
    note(`entrando na sala ${source.roomId.slice(0, 8)} para assistir ${source.displayName}`);
    const result = (await VesktopNative.buteco.web.joinRoom(source.roomId, "")) as ButecoResult<void>;
    if (!result.ok) {
        note(`joinRoom falhou: ${JSON.stringify(result.error).slice(0, 160)}`);
        autoJoinedRoomId = null;
        watchedUserId = null;
    }
    // O estado da sala chega pelo socket; o sync() inicia o vídeo.
}

/** Para de assistir (menu nativo / troca): fecha a conexão e sai da sala se fomos nós que entramos. */
function stopWatching() {
    watchedUserId = null;
    cancelRetry();
    stopPlayback();
    leaveAutoJoinedRoom();
}

/**
 * Para o próprio streamer o Discord trata o tile como "seu stream" (menu de
 * Stop/Change) e não alterna o player. Interceptamos o clique no NOSSO tile:
 * - na grade (botão Watch): foca o player nativo e começa a assistir;
 * - com o player em foco (clique no vídeo ou no Watch): volta para a grade.
 * Botões nativos dentro do tile (Options etc.) seguem funcionando.
 */
function handleWatchClick(event: MouseEvent) {
    if (!sources.size) return;

    const target = event.target as HTMLElement | null;
    const tile = target?.closest<HTMLElement>("[data-selenium-video-tile]");
    const userId = tile?.getAttribute("data-selenium-video-tile");
    const source = userId ? sources.get(userId) : undefined;
    if (!tile || !source) return;

    const button = target?.closest("button, [role=button]");
    const isWatchButton = Boolean(button && /watch/i.test(button.textContent || ""));
    const focused = tile.getBoundingClientRect().width > 600;
    const watching = watchedUserId === source.discordUserId;
    // O tile do próprio usuário (avatar) tem o mesmo atributo; só o nosso tem Watch/stream.
    if (!isWatchButton && !(focused && watching)) return;
    // Um botão que não é o Watch é do Discord (menu de opções etc.): não mexe.
    if (button && !isWatchButton) return;

    const channel = getVoiceChannel();
    const actions = findByProps("selectParticipant");
    if (!channel || !actions?.selectParticipant) return;

    event.preventDefault();
    event.stopPropagation();

    // O Discord pode já ter focado o tile sozinho (ex.: ao começar a transmitir): o
    // clique no Watch tem de pedir o vídeo mesmo assim, e só minimiza quem já assiste.
    if (!watching) void requestWatch(source);
    try {
        actions.selectParticipant(channel.channelId, focused && watching ? null : source.participant.id);
    } catch {
        // se a ação falhar, deixa o clique nativo seguir
    }
}

/**
 * Se o Discord focou um dos nossos tiles por conta própria (ou por qualquer outro
 * caminho que não o nosso clique), começa a assistir: o tile em foco sem vídeo
 * ficaria eternamente no "Watch Stream".
 */
function autoWatchSelected() {
    const channel = sources.size ? getVoiceChannel() : null;
    const selectedId = channel
        ? (findByProps("getStreamParticipants")?.getSelectedParticipantId?.(channel.channelId) ?? null)
        : null;
    const source = selectedId ? sourceByParticipantId(selectedId) : undefined;

    if (!source) {
        lastAutoWatchId = null;
        return;
    }
    if (lastAutoWatchId === selectedId || watchedUserId === source.discordUserId) return;

    lastAutoWatchId = selectedId;
    note(`tile focado sem assistir: iniciando (${source.displayName})`);
    void requestWatch(source);
}

/**
 * Menu nativo do tile (botão direito → Stop Streaming) e botões do player
 * disparam STREAM_STOP/STREAM_CLOSE com a chave do nosso stream falso. Para o
 * stream do próprio usuário isso para a transmissão do Buteco; para o de outra
 * pessoa só pára de assistir (volta para a grade e fecha a conexão local).
 */
function handleStreamStop(event: { streamKey?: string }) {
    const source = event?.streamKey ? sourceByStreamKey(event.streamKey) : undefined;
    if (!source) return;

    const isSelf = source.discordUserId === UserStore.getCurrentUser()?.id;
    note(`stop nativo (${isSelf ? "próprio" : "outro"})`);
    deselectIfSelected(source);

    if (isSelf) {
        void import("../components/ScreenSharePicker")
            .then(module => module.stopActiveButeco())
            .then(() => VesktopNative.buteco.web.unpublish())
            .catch(() => {});
        return;
    }

    if (watchedUserId === source.discordUserId) stopWatching();
}

/** Quem está compartilhando agora: a sala em que estamos + salas abertas do lobby. */
function collectDesired(): Desired[] {
    const state = getButecoWebState();
    const desired: Desired[] = [];

    const { room } = state;
    const member = findRoomStream(room);
    if (room && member) {
        desired.push({
            siteUserId: member.userId,
            displayName: member.displayName,
            roomId: room.roomId,
            joined: true
        });
    }

    for (const lobbyRoom of state.lobby ?? []) {
        if (!lobbyRoom.screenOwnerId || lobbyRoom.hasPassword || lobbyRoom.roomId === room?.roomId) continue;

        const owner =
            lobbyRoom.members?.find(candidate => candidate.userId === lobbyRoom.screenOwnerId)?.displayName ??
            (lobbyRoom.ownerId === lobbyRoom.screenOwnerId ? lobbyRoom.ownerName : undefined);
        if (!owner) continue;

        desired.push({
            siteUserId: lobbyRoom.screenOwnerId,
            displayName: owner,
            roomId: lobbyRoom.roomId,
            joined: false
        });
    }

    return desired;
}

function sync() {
    const state = getButecoWebState();

    // O lobby só chega depois da primeira assinatura; faz isso sem o painel aberto.
    if (!state.status.loggedIn) {
        lobbyRequested = false;
    } else if (state.lobby === null && !lobbyRequested) {
        lobbyRequested = true;
        void Promise.resolve(VesktopNative.buteco.web.lobby()).catch(() => {
            lobbyRequested = false;
        });
    }

    // A sala em que entramos sozinhos acabou/fechou: esquece a marca.
    if (autoJoinedRoomId && state.room?.roomId !== autoJoinedRoomId && !watchedUserId) autoJoinedRoomId = null;

    const channel = getVoiceChannel();
    const wanted = new Map<string, Desired>();
    if (channel) {
        for (const desired of collectDesired()) {
            const discordUserId = resolveDiscordUserId(desired.siteUserId, desired.displayName);
            if (discordUserId && !wanted.has(discordUserId)) wanted.set(discordUserId, desired);
        }
    }

    let changed = false;
    for (const [discordUserId, source] of [...sources]) {
        const desired = wanted.get(discordUserId);
        if (!desired || desired.roomId !== source.roomId || source.stream.channelId !== channel?.channelId) {
            removeSource(discordUserId);
            changed = true;
        } else {
            source.joined = desired.joined;
        }
    }
    if (channel) {
        for (const [discordUserId, desired] of wanted) {
            if (sources.has(discordUserId)) continue;
            if (addSource(discordUserId, desired, channel.channelId, channel.guildId)) changed = true;
        }
    }

    if (!sources.size) {
        if (origRtc || origStreams || origCollectionGetParticipant) unpatch();
        cancelRetry();
        stopPlayback();
    }
    if (changed) emitStoreChanges();

    const watched = watchedUserId ? sources.get(watchedUserId) : undefined;
    if (watched?.joined) void startPlayback(watched.discordUserId);
}

onceReady.then(() => {
    subscribeButecoWeb(sync);
    document.addEventListener("click", handleWatchClick, true);
    FluxDispatcher.subscribe("STREAM_STOP", handleStreamStop);
    FluxDispatcher.subscribe("STREAM_CLOSE", handleStreamStop);

    // O React remonta os tiles a cada mudança de layout; mantém o vídeo no
    // tile focado enquanto a conexão existir.
    const keepAlive = () => {
        autoWatchSelected();
        const watched = watchedUserId ? sources.get(watchedUserId) : undefined;
        if (watched?.joined && !pc && !retryTimer && !starting && retryAttempts < MAX_RETRIES) {
            void startPlayback(watched.discordUserId);
            return;
        }
        if (!pc || !mediaStream || !watchedUserId) return;

        const target = findWatchTarget(watchedUserId);
        if (!target) {
            removeVideo();
            return;
        }
        if (!video || !document.contains(video) || video.parentElement !== target.tile) injectVideo(mediaStream);
    };

    const observer = new MutationObserver(keepAlive);
    observer.observe(document.body, { childList: true, subtree: true });
    // Entrar/sair da call muda quem pode ser casado; reavalia periodicamente.
    setInterval(() => {
        keepAlive();
        sync();
    }, 3000);

    sync();
});
