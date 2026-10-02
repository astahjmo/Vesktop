/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByProps, onceReady, wreq } from "@vencord/types/webpack";
import { FluxDispatcher, UserStore } from "@vencord/types/webpack/common";
import type { ButecoIceServer, ButecoResult } from "shared/buteco";

import { findRoomStream, getButecoWebState, subscribeButecoWeb } from "./webState";

/**
 * Viewer "nativo": em vez de um tile próprio, injeta um participante sintético
 * do tipo STREAM no ChannelRTCStore do Discord. A UI nativa (grade, botão
 * Watch, player em foco, filme-strip, controles) passa a existir sozinha; o
 * vídeo do SFU do Buteco entra por cima do container do player via WHEP.
 *
 * Tudo é revertido quando a transmissão some (ou a sala fecha).
 */

const VIDEO_ID = "vc-buteco-native-video";

/** Tipos de participante do Discord (`lp`): STREAM = 0, USER = 2, ACTIVITY = 3. */
const PARTICIPANT_STREAM = 0;

const RETRY_MS = 4000;
const MAX_RETRIES = 6;

let installed = false;
let activeUserId: string | null = null;
let fakeStream: any = null;
let fakeParticipant: any = null;
let origRtc: {
    getParticipants: any;
    getFilteredParticipants: any;
    getStreamParticipants: any;
    getParticipant: any;
} | null = null;
let origStreams: { getActiveStreamForApplicationStream: any; getActiveStreamForStreamKey: any } | null = null;
let origCollectionGetParticipant: any = null;

let pc: RTCPeerConnection | null = null;
let mediaStream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempts = 0;
let starting = false;
/** Streamer que o usuário mandou parar de assistir (menu nativo); limpo ao desinstalar. */
let dismissedUserId: string | null = null;
const debugLog: string[] = [];

function note(message: string) {
    debugLog.push(`${new Date().toISOString().slice(11, 23)} ${message}`);
    if (debugLog.length > 40) debugLog.shift();
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
        return installed;
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

    note(`sem ponte site→Discord para "${displayName}"`);
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

/** Instala o stream/participante falso e patcha os stores. */
function install(userId: string, displayName: string, channelId: string, guildId: string | null): boolean {
    if (installed && activeUserId === userId) return true;

    const rtc = findByProps("getStreamParticipants");
    const streams = findByProps("getStreamForUser");
    const voiceStates = findByProps("getVoiceState");
    if (!rtc || !streams) return false;

    const user = UserStore.getUser(userId) ?? UserStore.getCurrentUser();
    // O Discord parseia a chave: `guild:<guildId>:<channelId>:<ownerId>` ou
    // `call:<channelId>:<ownerId>` (DM). Outro formato quebra o player nativo.
    const streamKey = guildId ? `guild:${guildId}:${channelId}:${userId}` : `call:${channelId}:${userId}`;

    fakeStream = {
        streamKey,
        channelId,
        guildId,
        ownerId: userId,
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

    fakeParticipant = {
        type: PARTICIPANT_STREAM,
        id: streamKey,
        user,
        userNick: displayName,
        voiceState: voiceStates?.getVoiceState?.(guildId, userId),
        speaking: false,
        soundsharing: false,
        ringing: false,
        localVideoDisabled: false,
        isPoppedOut: false,
        stream: fakeStream
    };

    if (!origRtc) {
        origRtc = {
            getParticipants: rtc.getParticipants,
            getFilteredParticipants: rtc.getFilteredParticipants,
            getStreamParticipants: rtc.getStreamParticipants,
            getParticipant: rtc.getParticipant
        };
        const originals = origRtc;
        const inject = (list: any[] | undefined) => {
            if (!fakeParticipant) return list ?? [];
            const items = list ?? [];
            return items.some(item => item.id === fakeParticipant.id) ? items : [...items, fakeParticipant];
        };
        const isOurChannel = (channelId: string) => channelId === fakeParticipant?.stream?.channelId;

        rtc.getParticipants = function (channelId: string) {
            const real = originals.getParticipants.call(this, channelId);
            return isOurChannel(channelId) ? inject(real) : real;
        };
        rtc.getFilteredParticipants = function (channelId: string) {
            const real = originals.getFilteredParticipants.call(this, channelId);
            return isOurChannel(channelId) ? inject(real) : real;
        };
        rtc.getStreamParticipants = function (channelId: string) {
            const real = originals.getStreamParticipants.call(this, channelId);
            return isOurChannel(channelId) ? inject(real) : real;
        };
        rtc.getParticipant = function (channelId: string, id: string) {
            if (fakeParticipant && id === fakeParticipant.id) return fakeParticipant;
            return originals.getParticipant.call(this, channelId, id);
        };
    }

    if (!origStreams) {
        origStreams = {
            getActiveStreamForApplicationStream: streams.getActiveStreamForApplicationStream,
            getActiveStreamForStreamKey: streams.getActiveStreamForStreamKey
        };
        const originals = origStreams;
        streams.getActiveStreamForApplicationStream = function (stream: any) {
            if (stream === fakeStream) return fakeStream;
            return originals.getActiveStreamForApplicationStream.call(this, stream);
        };
        streams.getActiveStreamForStreamKey = function (key: string) {
            if (fakeStream && key === fakeStream.streamKey) return fakeStream;
            return originals.getActiveStreamForStreamKey.call(this, key);
        };
    }

    if (!origCollectionGetParticipant) {
        const collection = findParticipantCollection();
        if (collection) {
            const original = collection.prototype.getParticipant;
            origCollectionGetParticipant = { collection, original };
            collection.prototype.getParticipant = function (id: string) {
                if (
                    fakeParticipant &&
                    id === fakeParticipant.id &&
                    this.channelId === fakeParticipant.stream?.channelId
                )
                    return fakeParticipant;
                return original.call(this, id);
            };
        }
    }

    activeUserId = userId;
    installed = true;
    try {
        rtc.emitChange?.();
        streams.emitChange?.();
    } catch {
        // um subscriber quebrado não deve impedir a injeção
    }
    return true;
}

function uninstall() {
    const rtc = findByProps("getStreamParticipants");
    const streams = findByProps("getStreamForUser");

    // Se o player estava focado no nosso stream, volta para a grade antes de sumir com ele.
    if (rtc && fakeParticipant) {
        const channelId = fakeParticipant.stream?.channelId;
        if (channelId && rtc.getSelectedParticipantId?.(channelId) === fakeParticipant.id) {
            try {
                findByProps("selectParticipant")?.selectParticipant?.(channelId, null);
            } catch {
                // sem seleção para limpar
            }
        }
    }

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
    fakeStream = null;
    fakeParticipant = null;
    activeUserId = null;
    dismissedUserId = null;
    installed = false;

    try {
        rtc?.emitChange?.();
        streams?.emitChange?.();
    } catch {
        // idem
    }
}

/** O tile do NOSSO stream: atributo de vídeo do usuário + botão Watch. */
function findFakeTile(): HTMLElement | null {
    if (!fakeParticipant) return null;
    const userId = fakeParticipant.user?.id;
    if (!userId) return null;

    const tiles = [...document.querySelectorAll<HTMLElement>(`[data-selenium-video-tile="${userId}"]`)];
    return tiles.find(tile => /watch/i.test(tile.textContent || "")) ?? null;
}

/** O tile focado (player): o nosso tile quando está grande. */
function findFocusedTile(): HTMLElement | null {
    if (!fakeParticipant) return null;
    const userId = fakeParticipant.user?.id;
    if (!userId) return null;

    const tiles = [...document.querySelectorAll<HTMLElement>(`[data-selenium-video-tile="${userId}"]`)];
    return tiles.find(tile => tile.getBoundingClientRect().width > 600) ?? null;
}

function removeVideo() {
    video?.remove();
    video = null;
}

function injectVideo(stream: MediaStream) {
    const tile = findFocusedTile();
    if (!tile) {
        // Sem player em foco: o tile nativo fica como está (botão Watch).
        removeVideo();
        return;
    }

    if (video && document.contains(video) && video.parentElement === tile) {
        if (video.srcObject !== stream) video.srcObject = stream;
        return;
    }

    removeVideo();
    video = document.createElement("video");
    video.id = VIDEO_ID;
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;z-index:5;pointer-events:none;";
    tile.style.position = "relative";
    tile.appendChild(video);

    video.srcObject = stream;
    void video.play().catch(() => {
        if (!video) return;
        video.muted = true;
        void video.play().catch(() => {});
    });
}

function scheduleRetry(userId: string) {
    if (retryTimer || retryAttempts >= MAX_RETRIES) return;
    retryTimer = setTimeout(
        () => {
            retryTimer = null;
            const member = findRoomStream(getButecoWebState().room);
            if (member?.userId !== userId) return;
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
    const channel = getVoiceChannel();
    if (!channel) return;

    const ice = (await VesktopNative.buteco.web.ice()) as ButecoResult<ButecoIceServer[]>;
    if (!ice.ok || activeUserId !== userId) {
        note(`ice falhou/usuário mudou (ok=${ice.ok}, ativo=${activeUserId})`);
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

/**
 * Para o próprio streamer o Discord trata o tile como "seu stream" (menu de
 * Stop/Change) e não alterna o player. Interceptamos o clique no NOSSO tile:
 * - na grade (botão Watch): foca o player nativo;
 * - com o player em foco (clique no vídeo ou no Watch): volta para a grade.
 * Botões nativos dentro do tile (Options etc.) seguem funcionando.
 */
function handleWatchClick(event: MouseEvent) {
    if (!installed || !fakeParticipant) return;

    const target = event.target as HTMLElement | null;
    const tile = target?.closest<HTMLElement>(`[data-selenium-video-tile="${fakeParticipant.user?.id}"]`);
    if (!tile) return;

    const button = target?.closest("button, [role=button]");
    const isWatchButton = Boolean(button && /watch/i.test(button.textContent || ""));
    const focused = tile.getBoundingClientRect().width > 600;
    // Um botão que não é o Watch é do Discord (menu de opções etc.): não mexe.
    if (button && !isWatchButton) return;
    // Clique solto no tile só interessa com o player em foco.
    if (!button && !focused) return;

    const channel = getVoiceChannel();
    const actions = findByProps("selectParticipant");
    if (!channel || !actions?.selectParticipant) return;

    event.preventDefault();
    event.stopPropagation();
    if (!focused && dismissedUserId === activeUserId) {
        // Voltou a assistir depois de "parar" pelo menu nativo.
        dismissedUserId = null;
        if (activeUserId) void startPlayback(activeUserId);
    }
    try {
        actions.selectParticipant(channel.channelId, focused ? null : fakeParticipant.id);
    } catch {
        // se a ação falhar, deixa o clique nativo seguir
    }
}

/**
 * Menu nativo do tile (botão direito → Stop Streaming) e botões do player
 * disparam STREAM_STOP/STREAM_CLOSE com a chave do nosso stream falso. Para o
 * stream do próprio usuário isso para a transmissão do Buteco; para o de outra
 * pessoa só pára de assistir (volta para a grade e fecha a conexão local).
 */
function handleStreamStop(event: { streamKey?: string }) {
    if (!installed || !fakeStream || !fakeParticipant || event?.streamKey !== fakeStream.streamKey) return;

    const { channelId } = fakeStream;
    const { ownerId } = fakeStream;
    const isSelf = ownerId === UserStore.getCurrentUser()?.id;
    note(`stop nativo (${isSelf ? "próprio" : "outro"})`);

    // Sai do player em foco antes de qualquer outra coisa.
    try {
        const rtc = findByProps("getStreamParticipants");
        if (rtc?.getSelectedParticipantId?.(channelId) === fakeParticipant.id) {
            findByProps("selectParticipant")?.selectParticipant?.(channelId, null);
        }
    } catch {
        // sem seleção para limpar
    }

    if (isSelf) {
        void import("../components/ScreenSharePicker")
            .then(module => module.stopActiveButeco())
            .then(() => VesktopNative.buteco.web.unpublish())
            .catch(() => {});
        return;
    }

    dismissedUserId = ownerId;
    cancelRetry();
    stopPlayback();
}

function sync() {
    const member = findRoomStream(getButecoWebState().room);
    const channel = getVoiceChannel();

    if (!member || !channel) {
        cancelRetry();
        if (installed) uninstall();
        stopPlayback();
        return;
    }

    const discordUserId = resolveDiscordUserId(member.userId, member.displayName);
    if (!discordUserId) {
        // Sem ponte site→Discord para esse membro; não dá para injetar.
        if (installed) uninstall();
        stopPlayback();
        return;
    }

    if (!installed || activeUserId !== discordUserId) {
        if (installed) uninstall();
        if (!install(discordUserId, member.displayName, channel.channelId, channel.guildId)) return;
    }

    if (discordUserId !== dismissedUserId) void startPlayback(discordUserId);
}

onceReady.then(() => {
    subscribeButecoWeb(sync);
    document.addEventListener("click", handleWatchClick, true);
    FluxDispatcher.subscribe("STREAM_STOP", handleStreamStop);
    FluxDispatcher.subscribe("STREAM_CLOSE", handleStreamStop);

    // O React remonta os tiles a cada mudança de layout; mantém o vídeo no
    // tile focado enquanto a conexão existir.
    const keepAlive = () => {
        if (
            installed &&
            !pc &&
            activeUserId &&
            activeUserId !== dismissedUserId &&
            !retryTimer &&
            !starting &&
            retryAttempts < MAX_RETRIES
        ) {
            void startPlayback(activeUserId);
            return;
        }
        if (!pc || !mediaStream) return;
        const tile = findFocusedTile();
        if (!tile) {
            removeVideo();
            return;
        }
        if (!video || !document.contains(video) || video.parentElement !== tile) injectVideo(mediaStream);
    };

    const observer = new MutationObserver(keepAlive);
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(keepAlive, 1000);

    sync();
});
