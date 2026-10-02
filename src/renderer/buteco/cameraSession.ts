/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@vencord/types/webpack/common";
import type { ButecoRoomState } from "shared/butecoWeb";

import { ensureButecoRoom } from "./room";
import { ensureSfu, getSfuSession, subscribeSfuBroken } from "./sfu";
import { CAMERA_PRESETS } from "./sfuPresets";
import type { SfuSession } from "./sfuSession";
import { SfuError } from "./sfuUtil";
import { getButecoWebState, subscribeButecoWeb } from "./webState";

/**
 * Publicar a própria câmera no SFU (mesmo protocolo do site):
 *  1. a sessão do SFU já tem o slot de câmera (ver `sfu.ts`);
 *  2. liga a webcam e coloca a faixa no slot (`replaceTrack`);
 *  3. `camera {on:true}`: o servidor devolve uma oferta que respondemos via `renegotiate`.
 */

/** Tempo máximo esperando a mídia da sessão conectar antes de desistir. */
const MEDIA_CONNECT_TIMEOUT_MS = 12_000;
const BUSY_RETRIES = 2;
const BUSY_RETRY_MS = 300;
/** Tempo para o servidor refletir a nossa câmera no estado antes de checarmos. */
const STATE_GRACE_MS = 4000;

const MESSAGES: Record<string, string> = {
    denied: "Você não liberou a câmera — ela continua desligada.",
    no_device: "Nenhuma câmera encontrada.",
    in_use: "Sua câmera está em uso por outro app.",
    full: "Mesa cheia de câmeras.",
    blocked: "Um admin bloqueou sua câmera temporariamente.",
    rate_limited: "Calma aí! Tente de novo em instantes.",
    lost: "A conexão da câmera caiu. Tente ligar de novo.",
    dropped: "O servidor desligou sua câmera.",
    no_media: "Não consegui conectar ao servidor de mídia. Tente de novo.",
    generic: "Não foi possível ligar a câmera. Tente de novo."
};

export interface ButecoCameraState {
    enabled: boolean;
    busy: boolean;
    error: string | null;
}

let state: ButecoCameraState = { enabled: false, busy: false, error: null };
const listeners = new Set<() => void>();

let localStream: MediaStream | null = null;
/** Sala em que a câmera foi ligada (a câmera não acompanha o usuário para outra sala). */
let cameraRoomId: string | null = null;
let enabledAt = 0;
let queue: Promise<unknown> = Promise.resolve();
const debugLog: string[] = [];

function note(message: string) {
    debugLog.push(`${new Date().toISOString().slice(11, 23)} ${message}`);
    if (debugLog.length > 40) debugLog.shift();
}

(globalThis as any).__butecoCamera = {
    get state() {
        return state;
    },
    get log() {
        return debugLog;
    },
    get pc() {
        return getSfuSession()?.pc ?? null;
    }
};

export function getButecoCameraState(): ButecoCameraState {
    return state;
}

/** Stream da webcam local enquanto a câmera do Buteco está ligada. */
export function getLocalCameraStream(): MediaStream | null {
    return state.enabled ? localStream : null;
}

function setState(patch: Partial<ButecoCameraState>) {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            // um assinante quebrado não bloqueia os outros
        }
    }
}

export function subscribeButecoCamera(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useButecoCameraState(): ButecoCameraState {
    const [value, setValue] = useState(getButecoCameraState());

    useEffect(() => {
        setValue(getButecoCameraState());
        return subscribeButecoCamera(() => setValue(getButecoCameraState()));
    }, []);

    return value;
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
}

function stopLocalStream() {
    for (const track of localStream?.getTracks() ?? []) track.stop();
    localStream = null;
}

/** A conexão/sala sumiu por fora: derruba a câmera local sem falar com o servidor. */
function dropLocalCamera(reason: string | null) {
    stopLocalStream();
    cameraRoomId = null;
    setState({ enabled: false, busy: false, error: reason ? MESSAGES[reason] : null });
}

async function requestCamera(session: SfuSession, on: boolean) {
    for (let attempt = 0; ; attempt++) {
        try {
            await session.setServerCamera(on);
            return;
        } catch (error) {
            // `busy`: o servidor ainda fecha a renegociação anterior; tenta de novo.
            if ((error as SfuError).reason === "busy" && attempt < BUSY_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, BUSY_RETRY_MS));
                continue;
            }
            throw error;
        }
    }
}

function captureErrorReason(error: unknown): string {
    const name = error instanceof Error ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") return "denied";
    if (name === "NotReadableError" || name === "AbortError") return "in_use";
    return "no_device";
}

async function captureCamera(room: ButecoRoomState): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) throw new SfuError(MESSAGES.no_device, "no_device");

    const { capture } = CAMERA_PRESETS[room.quality] ?? CAMERA_PRESETS.economica;
    try {
        return await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                width: { ideal: capture.width },
                height: { ideal: capture.height },
                frameRate: { ideal: capture.frameRate, max: capture.frameRate }
            }
        });
    } catch (error) {
        const reason = captureErrorReason(error);
        throw new SfuError(MESSAGES[reason], reason);
    }
}

function failureMessage(error: unknown): string {
    const reason = (error as SfuError)?.reason;
    if (reason === "room") return (error as SfuError).message;
    if (reason && MESSAGES[reason]) return MESSAGES[reason];
    note(`falha: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
    return MESSAGES.generic;
}

export function enableButecoCamera(): Promise<void> {
    return enqueue(async () => {
        if (state.busy || state.enabled) return;
        setState({ busy: true, error: null });

        let stream: MediaStream | null = null;
        let session: SfuSession | null = null;
        let serverNotified = false;
        try {
            const roomReady = await ensureButecoRoom();
            if (!roomReady.ok) throw new SfuError(roomReady.error.message, "room");

            session = await ensureSfu();
            const { room } = getButecoWebState();
            if (!room) throw new SfuError(MESSAGES.generic, "generic");

            // Sem mídia conectada o servidor registraria a câmera sem receber nada.
            if (!(await session.waitForMedia(MEDIA_CONNECT_TIMEOUT_MS)))
                throw new SfuError(MESSAGES.no_media, "no_media");

            stream = await captureCamera(room);
            await session.setCameraTrack(stream.getVideoTracks()[0]);
            serverNotified = true;
            await requestCamera(session, true);

            localStream = stream;
            cameraRoomId = room.roomId;
            enabledAt = Date.now();
            setState({ enabled: true, busy: false });
            note("câmera ligada");
        } catch (error) {
            for (const track of stream?.getTracks() ?? []) track.stop();
            await session?.setCameraTrack(null).catch(() => {});
            // O servidor pode ter registrado a câmera antes da falha: garante o desligamento.
            if (session && serverNotified) await requestCamera(session, false).catch(() => {});
            setState({ enabled: false, busy: false, error: failureMessage(error) });
        }
    });
}

export function disableButecoCamera(): Promise<void> {
    return enqueue(async () => {
        if (state.busy) return;
        setState({ busy: true, error: null });

        const session = getSfuSession();
        stopLocalStream();
        try {
            await session?.setCameraTrack(null);
            if (session && getButecoWebState().room?.roomId === session.roomId) await requestCamera(session, false);
            cameraRoomId = null;
            setState({ enabled: false, busy: false });
            note("câmera desligada");
        } catch (error) {
            cameraRoomId = null;
            setState({ enabled: false, busy: false, error: failureMessage(error) });
        }
    });
}

// A hub derruba a sessão sozinha; a câmera local precisa refletir isso.
subscribeSfuBroken(() => {
    if (state.enabled || state.busy) dropLocalCamera("lost");
});

/** Sair/trocar de sala derruba a câmera; o servidor já a limpa ao sairmos. */
subscribeButecoWeb(() => {
    const { room, status } = getButecoWebState();

    if (cameraRoomId && (!room || room.roomId !== cameraRoomId)) {
        dropLocalCamera(null);
        return;
    }

    // O servidor tirou a nossa câmera do ar (admin/bloqueio/reset): reflete na UI.
    if (state.enabled && !state.busy && room && Date.now() - enabledAt > STATE_GRACE_MS) {
        const me = room.members.find(member => member.userId === status.user?.id);
        if (me && !me.cameraId) dropLocalCamera("dropped");
    }
});
