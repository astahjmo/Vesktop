/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const ICE_GATHER_TIMEOUT_MS = 5000;

/** Erro do SFU; `reason` carrega o motivo cru do servidor (busy, full, blocked...). */
export class SfuError extends Error {
    constructor(
        message: string,
        readonly reason: string
    ) {
        super(message);
    }
}

/** Espera a coleta de candidatos terminar (ou o tempo máximo), como o site faz antes de trocar SDP. */
export function waitForIce(pc: RTCPeerConnection, timeoutMs = ICE_GATHER_TIMEOUT_MS): Promise<void> {
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
        const timer = setTimeout(done, timeoutMs);
        pc.addEventListener("icegatheringstatechange", onChange);
    });
}

/** Resolve `true` quando a conexão fecha; `false` se falhar ou estourar o tempo. */
export function waitForConnected(pc: RTCPeerConnection, timeoutMs: number): Promise<boolean> {
    if (pc.connectionState === "connected") return Promise.resolve(true);
    if (pc.connectionState === "failed" || pc.connectionState === "closed") return Promise.resolve(false);

    return new Promise(resolve => {
        const finish = (ok: boolean) => {
            pc.removeEventListener("connectionstatechange", onChange);
            clearTimeout(timer);
            resolve(ok);
        };
        const onChange = () => {
            if (pc.connectionState === "connected") finish(true);
            else if (pc.connectionState === "failed" || pc.connectionState === "closed") finish(false);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        pc.addEventListener("connectionstatechange", onChange);
    });
}

/** Faixa de vídeo preta para ocupar um slot até haver vídeo de verdade. */
export function createPlaceholderTrack(): MediaStreamTrack {
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

/** O SFU negocia VP8: põe VP8 (e rtx) na frente, sem remover os demais. */
export function preferVp8(transceiver: RTCRtpTransceiver) {
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
