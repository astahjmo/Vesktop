/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoIceServer, ButecoResult } from "shared/buteco";
import type { ButecoRoomState } from "shared/butecoWeb";

import type { StreamKind } from "./sfuPlan";
import { CAMERA_PRESETS, screenPreset } from "./sfuPresets";
import { type SfuCall, SfuSession, type SfuSyncState } from "./sfuSession";
import { SfuError } from "./sfuUtil";
import { getButecoWebState, subscribeButecoWeb } from "./webState";

/**
 * Sessão única do SFU por sala. Guarda os streams remotos puxados, abre a
 * sessão sozinha quando há algo para puxar (câmera de alguém, ou uma tela que
 * você pediu para assistir) e a derruba ao sair da sala.
 */

type RemoteListener = (userId: string, kind: StreamKind, stream: MediaStream | null) => void;

let session: SfuSession | null = null;
let connecting: Promise<SfuSession> | null = null;
let wantCameras = true;
/** Evita reconectar em loop quando o SFU está inalcançável. */
const AUTO_CONNECT_COOLDOWN_MS = 15_000;
let lastAutoConnectFailure = 0;

/** ids (do site) de quem o usuário quer assistir pelo SFU. */
const wantedScreens = new Set<string>();
const remote = new Map<string, MediaStream>();
const remoteListeners = new Set<RemoteListener>();
const brokenListeners = new Set<() => void>();

const key = (userId: string, kind: StreamKind) => `${userId}:${kind}`;

/** Chamada ao SFU pelo processo principal; devolve o corpo ou lança `SfuError` com o motivo. */
const call: SfuCall = async (op, payload) => {
    const result = (await VesktopNative.buteco.web.sfu(op, payload)) as ButecoResult<any>;
    if (!result.ok) throw new SfuError(result.error.message, result.error.message);
    return result.value;
};

export function subscribeRemoteStreams(listener: RemoteListener): () => void {
    remoteListeners.add(listener);
    return () => {
        remoteListeners.delete(listener);
    };
}

/** Avisado quando a sessão cai por conta própria (não quando nós a fechamos). */
export function subscribeSfuBroken(listener: () => void): () => void {
    brokenListeners.add(listener);
    return () => {
        brokenListeners.delete(listener);
    };
}

export function getRemoteStream(userId: string, kind: StreamKind): MediaStream | null {
    return remote.get(key(userId, kind)) ?? null;
}

export function getSfuSession(): SfuSession | null {
    return session && !session.isClosed ? session : null;
}

export function setWantCameras(value: boolean) {
    if (wantCameras === value) return;
    wantCameras = value;
    syncNow();
}

/** Pede (ou deixa de pedir) a tela de alguém pelo SFU do Cloudflare. */
export function wantScreenFrom(siteUserId: string, on: boolean) {
    const changed = on ? !wantedScreens.has(siteUserId) : wantedScreens.delete(siteUserId);
    if (on) wantedScreens.add(siteUserId);
    if (changed) handleRoomState();
}

function emitRemote(userId: string, kind: StreamKind, stream: MediaStream | null) {
    if (stream) remote.set(key(userId, kind), stream);
    else remote.delete(key(userId, kind));

    for (const listener of [...remoteListeners]) {
        try {
            listener(userId, kind, stream);
        } catch {
            // um assinante quebrado não bloqueia os outros
        }
    }
}

function cameraPresetFor(room: ButecoRoomState) {
    return CAMERA_PRESETS[room.quality] ?? CAMERA_PRESETS.economica;
}

async function connectSession(room: ButecoRoomState): Promise<SfuSession> {
    const iceResult = (await VesktopNative.buteco.web.ice()) as ButecoResult<ButecoIceServer[]>;
    const created = new SfuSession(room.roomId, iceResult.ok ? iceResult.value : [], call, {
        onRemoteStream: emitRemote,
        onBroken: () => {
            if (session !== created) return;
            closeSfu();
            for (const listener of [...brokenListeners]) listener();
        }
    });

    try {
        await created.connect(cameraPresetFor(room), screenPreset(720, 30));
    } catch (error) {
        created.close();
        throw error;
    }
    return created;
}

/** Abre a sessão da sala atual (ou reaproveita a que já existe). */
export async function ensureSfu(): Promise<SfuSession> {
    const { room } = getButecoWebState();
    if (!room) throw new SfuError("Entre numa sala primeiro.", "generic");

    if (session && !session.isClosed && session.roomId === room.roomId && session.pc.connectionState !== "failed") {
        return session;
    }
    if (session) closeSfu();

    connecting ??= connectSession(room).finally(() => {
        connecting = null;
    });
    const created = await connecting;

    // A sala pode ter mudado enquanto conectava.
    if (getButecoWebState().room?.roomId !== created.roomId) {
        created.close();
        throw new SfuError("A sala mudou.", "generic");
    }
    session = created;
    syncNow();
    return created;
}

export function closeSfu() {
    const current = session;
    session = null;
    current?.close();
    for (const streamKey of [...remote.keys()]) {
        const [userId, kind] = streamKey.split(":") as [string, StreamKind];
        emitRemote(userId, kind, null);
    }
}

function buildSyncState(): SfuSyncState | null {
    const { room, status } = getButecoWebState();
    if (!room || !status.user) return null;

    return {
        selfId: status.user.id,
        members: room.members.map(member => ({
            userId: member.userId,
            cameraId: member.cameraId,
            screenId: member.screenId,
            screenTransport: member.screenTransport
        })),
        wantCameras,
        wantScreensFrom: wantedScreens
    };
}

function syncNow() {
    const state = buildSyncState();
    if (state && session && !session.isClosed) session.requestSync(state);
}

/** Há algo para puxar do SFU agora? (câmera de outro membro, ou tela pedida pelo Cloudflare) */
function hasSomethingToPull(): boolean {
    const state = buildSyncState();
    if (!state) return false;

    return state.members.some(member => {
        if (member.userId === state.selfId) return false;
        if (wantCameras && member.cameraId) return true;
        return Boolean(member.screenId && member.screenTransport !== "mediamtx" && wantedScreens.has(member.userId));
    });
}

function handleRoomState() {
    const { room } = getButecoWebState();

    if (session && (!room || room.roomId !== session.roomId)) {
        closeSfu();
        wantedScreens.clear();
        return;
    }
    if (session && !session.isClosed) {
        syncNow();
        return;
    }
    if (!connecting && room && hasSomethingToPull() && Date.now() - lastAutoConnectFailure > AUTO_CONNECT_COOLDOWN_MS) {
        void ensureSfu().catch(() => {
            lastAutoConnectFailure = Date.now();
        });
    }
}

subscribeButecoWeb(handleRoomState);
