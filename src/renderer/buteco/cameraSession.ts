/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@vencord/types/webpack/common";
import type { ButecoIceServer, ButecoResult } from "shared/buteco";
import type { ButecoRoomQuality, ButecoRoomState } from "shared/butecoWeb";

import { getButecoWebState, subscribeButecoWeb } from "./webState";

/**
 * Câmera no SFU do Buteco (mesmo protocolo do site):
 *  1. `connect`: PC com dois slots de envio (câmera e tela) com faixas vazias;
 *  2. liga a webcam e coloca a faixa no slot da câmera (`replaceTrack`);
 *  3. `camera {on:true}`: o servidor devolve uma oferta SDP (republish), que
 *     respondemos via `renegotiate`.
 * A sessão vive enquanto estivermos na sala.
 */

interface QualityPreset {
    capture: { width: number; height: number; frameRate: number };
    layers: Array<{ rid: string; scaleResolutionDownBy: number; maxBitrateKbps: number; maxFramerate: number }>;
}

/** Espelha os presets do site (`economica` / `alta`). */
const PRESETS: Record<ButecoRoomQuality, QualityPreset> = {
    economica: {
        capture: { width: 640, height: 360, frameRate: 20 },
        layers: [
            { rid: "h", scaleResolutionDownBy: 1, maxBitrateKbps: 450, maxFramerate: 20 },
            { rid: "l", scaleResolutionDownBy: 2, maxBitrateKbps: 120, maxFramerate: 12 }
        ]
    },
    alta: {
        capture: { width: 1280, height: 720, frameRate: 24 },
        layers: [
            { rid: "h", scaleResolutionDownBy: 1, maxBitrateKbps: 1200, maxFramerate: 24 },
            { rid: "l", scaleResolutionDownBy: 4, maxBitrateKbps: 200, maxFramerate: 15 }
        ]
    }
};

const ICE_GATHER_TIMEOUT_MS = 5000;
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
    generic: "Não foi possível ligar a câmera. Tente de novo."
};

export interface ButecoCameraState {
    enabled: boolean;
    busy: boolean;
    error: string | null;
}

class CameraError extends Error {
    constructor(
        message: string,
        readonly reason: string
    ) {
        super(message);
    }
}

interface CameraSession {
    roomId: string;
    pc: RTCPeerConnection;
    camera: RTCRtpTransceiver;
}

let state: ButecoCameraState = { enabled: false, busy: false, error: null };
const listeners = new Set<() => void>();

let session: CameraSession | null = null;
let connecting: Promise<CameraSession> | null = null;
let localStream: MediaStream | null = null;
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
        return session?.pc ?? null;
    }
};

export function getButecoCameraState(): ButecoCameraState {
    return state;
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

async function sfu<T = any>(op: Parameters<typeof VesktopNative.buteco.web.sfu>[0], payload?: Record<string, unknown>) {
    const result = (await VesktopNative.buteco.web.sfu(op, payload)) as ButecoResult<T>;
    if (!result.ok) throw new CameraError(result.error.message, result.error.message);
    return result.value;
}

function waitForIce(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();

    return new Promise(resolve => {
        const done = () => {
            pc.removeEventListener("icegatheringstatechange", onChange);
            clearTimeout(timer);
            resolve();
        };
        const onChange = () => {
            if (pc.iceGatheringState === "complete") done();
        };
        const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
        pc.addEventListener("icegatheringstatechange", onChange);
    });
}

/** Faixa de vídeo preta para ocupar o slot até a câmera ligar. */
function createPlaceholderTrack(): MediaStreamTrack {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    if (context) {
        context.fillStyle = "black";
        context.fillRect(0, 0, canvas.width, canvas.height);
    }
    return canvas.captureStream(1).getVideoTracks()[0];
}

function preferVp8(transceiver: RTCRtpTransceiver) {
    if (typeof transceiver.setCodecPreferences !== "function") return;
    const codecs = (RTCRtpReceiver.getCapabilities?.("video")?.codecs ?? []).filter(codec =>
        /^video\/(vp8|rtx)$/i.test(codec.mimeType)
    );
    if (!codecs.some(codec => /vp8/i.test(codec.mimeType))) return;
    try {
        transceiver.setCodecPreferences(codecs);
    } catch {
        // codecs indisponíveis: segue com o padrão do navegador
    }
}

function encodingsFor(preset: QualityPreset): RTCRtpEncodingParameters[] {
    return preset.layers.map(layer => ({
        rid: layer.rid,
        scaleResolutionDownBy: layer.scaleResolutionDownBy,
        maxBitrate: layer.maxBitrateKbps * 1000,
        maxFramerate: layer.maxFramerate
    }));
}

function stopLocalStream() {
    for (const track of localStream?.getTracks() ?? []) track.stop();
    localStream = null;
}

function closeSession() {
    const current = session;
    session = null;
    if (!current) return;
    try {
        current.pc.close();
    } catch {
        // já fechado
    }
}

/** A conexão/sala sumiu por fora: derruba a câmera local sem falar com o servidor. */
function dropLocalCamera(reason: string | null) {
    stopLocalStream();
    closeSession();
    setState({ enabled: false, busy: false, error: reason ? MESSAGES[reason] : null });
}

async function connectSession(room: ButecoRoomState): Promise<CameraSession> {
    const iceResult = (await VesktopNative.buteco.web.ice()) as ButecoResult<ButecoIceServer[]>;
    const iceServers = iceResult.ok ? iceResult.value : [];

    const preset = PRESETS[room.quality] ?? PRESETS.economica;
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
    const placeholders = [createPlaceholderTrack(), createPlaceholderTrack()];

    try {
        const camera = pc.addTransceiver(placeholders[0], {
            direction: "sendonly",
            sendEncodings: encodingsFor(preset)
        });
        // Slot de tela: reservado pelo protocolo, mas não usado por aqui.
        const screen = pc.addTransceiver(placeholders[1], {
            direction: "sendonly",
            sendEncodings: encodingsFor(preset)
        });
        preferVp8(camera);
        preferVp8(screen);

        await pc.setLocalDescription(await pc.createOffer());
        await waitForIce(pc);

        const cameraMid = camera.mid;
        const screenMid = screen.mid;
        if (!cameraMid || !screenMid || !pc.localDescription) throw new CameraError(MESSAGES.generic, "generic");

        const answer = await sfu<{ sdp: string }>("connect", {
            sdp: pc.localDescription.sdp,
            mids: { camera: cameraMid, screen: screenMid }
        });
        await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });

        // Libera os slots: a câmera real entra por replaceTrack depois.
        await camera.sender.replaceTrack(null);
        await screen.sender.replaceTrack(null);

        const created: CameraSession = { roomId: room.roomId, pc, camera };
        pc.onconnectionstatechange = () => {
            note(`pc ${pc.connectionState}`);
            if (session === created && (pc.connectionState === "failed" || pc.connectionState === "closed")) {
                dropLocalCamera("lost");
            }
        };
        return created;
    } catch (error) {
        try {
            pc.close();
        } catch {
            // já fechado
        }
        throw error;
    } finally {
        for (const track of placeholders) track.stop();
    }
}

async function ensureSession(): Promise<CameraSession> {
    const { room } = getButecoWebState();
    if (!room) throw new CameraError("Entre numa sala primeiro.", "generic");

    if (session && session.roomId === room.roomId && !["failed", "closed"].includes(session.pc.connectionState)) {
        return session;
    }
    closeSession();

    connecting ??= connectSession(room).finally(() => {
        connecting = null;
    });
    const created = await connecting;
    session = created;
    note(`sessão conectada (sala ${room.roomId.slice(0, 8)}, preset ${room.quality})`);
    return created;
}

async function answerRepublish(current: CameraSession, sdp: string) {
    const { pc } = current;
    await pc.setRemoteDescription({ type: "offer", sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIce(pc);
    if (!pc.localDescription) throw new CameraError(MESSAGES.generic, "generic");
    await sfu("renegotiate", { sdp: pc.localDescription.sdp });
}

async function requestCamera(current: CameraSession, on: boolean) {
    for (let attempt = 0; ; attempt++) {
        try {
            const result = await sfu<{ sdp?: string } | undefined>("camera", { on });
            if (result?.sdp) await answerRepublish(current, result.sdp);
            return;
        } catch (error) {
            // `busy`: o servidor ainda fecha a renegociação anterior; tenta de novo.
            if ((error as CameraError).reason === "busy" && attempt < BUSY_RETRIES) {
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
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraError(MESSAGES.no_device, "no_device");

    const { capture } = PRESETS[room.quality] ?? PRESETS.economica;
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
        throw new CameraError(MESSAGES[reason], reason);
    }
}

function failureMessage(error: unknown): string {
    const reason = (error as CameraError)?.reason;
    if (reason && MESSAGES[reason]) return MESSAGES[reason];
    note(`falha: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
    return MESSAGES.generic;
}

export function enableButecoCamera(): Promise<void> {
    return enqueue(async () => {
        if (state.busy || state.enabled) return;
        setState({ busy: true, error: null });

        let stream: MediaStream | null = null;
        let current: CameraSession | null = null;
        let serverNotified = false;
        try {
            current = await ensureSession();
            const { room } = getButecoWebState();
            if (!room) throw new CameraError(MESSAGES.generic, "generic");

            stream = await captureCamera(room);
            await current.camera.sender.replaceTrack(stream.getVideoTracks()[0]);
            serverNotified = true;
            await requestCamera(current, true);

            localStream = stream;
            enabledAt = Date.now();
            setState({ enabled: true, busy: false });
            note("câmera ligada");
        } catch (error) {
            for (const track of stream?.getTracks() ?? []) track.stop();
            await current?.camera.sender.replaceTrack(null).catch(() => {});
            // O servidor pode ter registrado a câmera antes da falha: garante o desligamento.
            if (current && serverNotified) await requestCamera(current, false).catch(() => {});
            setState({ enabled: false, busy: false, error: failureMessage(error) });
        }
    });
}

export function disableButecoCamera(): Promise<void> {
    return enqueue(async () => {
        if (state.busy) return;
        setState({ busy: true, error: null });

        const current = session;
        stopLocalStream();
        try {
            await current?.camera.sender.replaceTrack(null).catch(() => {});
            if (current && getButecoWebState().room?.roomId === current.roomId) await requestCamera(current, false);
            setState({ enabled: false, busy: false });
            note("câmera desligada");
        } catch (error) {
            // Sessão em estado incerto: recomeça do zero na próxima vez.
            closeSession();
            setState({ enabled: false, busy: false, error: failureMessage(error) });
        }
    });
}

/** Sair/trocar de sala derruba a sessão; o servidor já limpa a câmera ao sairmos. */
subscribeButecoWeb(() => {
    const { room, status } = getButecoWebState();

    if (session && (!room || room.roomId !== session.roomId)) {
        dropLocalCamera(null);
        return;
    }

    // O servidor tirou a nossa câmera do ar (admin/bloqueio/reset): reflete na UI.
    if (state.enabled && !state.busy && room && Date.now() - enabledAt > STATE_GRACE_MS) {
        const me = room.members.find(member => member.userId === status.user?.id);
        if (me && !me.cameraId) dropLocalCamera("dropped");
    }
});
