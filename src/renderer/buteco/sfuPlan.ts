/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type StreamKind = "camera" | "screen";

/** Faixa remota já puxada do SFU (identificada pelo `mid` do transceiver). */
export interface PulledStream {
    userId: string;
    kind: StreamKind;
    streamId: string;
    mid: string;
    rid: "h" | "l";
}

export interface SyncMember {
    userId: string;
    cameraId?: string | null;
    screenId?: string | null;
    screenTransport?: string | null;
}

export interface SyncInput {
    selfId: string;
    members: SyncMember[];
    pulled: PulledStream[];
    /** Chaves `userId:kind` que acabaram de falhar (esperam o próximo retry). */
    skip: ReadonlySet<string>;
    /** Puxa a câmera de todos os outros membros. */
    wantCameras: boolean;
    /** De quem puxar a tela (só vale para telas que saem pelo SFU do Cloudflare). */
    wantScreensFrom: ReadonlySet<string>;
}

export interface SyncPlan {
    pull: Array<{ userId: string; kind: StreamKind }>;
    /** `mid`s de faixas que sumiram ou trocaram de stream. */
    close: string[];
}

export const streamKey = (userId: string, kind: StreamKind) => `${userId}:${kind}`;

/**
 * Diferença entre o que a sala oferece e o que já está puxado. Porta fiel da
 * regra do site: nunca puxa o próprio stream, e uma faixa cujo `streamId` mudou
 * é fechada e puxada de novo.
 */
export function planSync(input: SyncInput): SyncPlan {
    const desired = new Map<string, { userId: string; kind: StreamKind; streamId: string }>();

    for (const member of input.members) {
        if (member.userId === input.selfId) continue;

        if (input.wantCameras && member.cameraId) {
            desired.set(streamKey(member.userId, "camera"), {
                userId: member.userId,
                kind: "camera",
                streamId: member.cameraId
            });
        }
        // Tela pelo MediaMTX não entra no SFU: quem assiste usa o WHEP.
        if (member.screenId && member.screenTransport !== "mediamtx" && input.wantScreensFrom.has(member.userId)) {
            desired.set(streamKey(member.userId, "screen"), {
                userId: member.userId,
                kind: "screen",
                streamId: member.screenId
            });
        }
    }

    const kept = new Set<string>();
    const close: string[] = [];
    for (const pulled of input.pulled) {
        const key = streamKey(pulled.userId, pulled.kind);
        if (desired.get(key)?.streamId === pulled.streamId) kept.add(key);
        else close.push(pulled.mid);
    }

    const pull: SyncPlan["pull"] = [];
    for (const [key, want] of desired) {
        if (!kept.has(key) && !input.skip.has(key)) pull.push({ userId: want.userId, kind: want.kind });
    }

    return { pull, close };
}

/** Camada pedida ao puxar: alta para quem está em foco ou quando há poucas câmeras. */
export function pullLayer(options: { remoteCameraCount: number; focused: boolean }): "h" | "l" {
    return options.focused || options.remoteCameraCount <= 4 ? "h" : "l";
}
