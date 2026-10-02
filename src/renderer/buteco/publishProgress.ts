/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ScreenTransport } from "./screenTransport";

/**
 * Em que ponto está o início de uma transmissão. A UI usa isso para mostrar um
 * carregamento (e travar o botão) em vez de deixar a pessoa clicar de novo
 * enquanto o app negocia a conexão.
 */
export type PublishPhase =
    | { step: "idle" }
    | { step: "room" }
    | { step: "capture" }
    | { step: "connecting"; transport: ScreenTransport; attempt: number; total: number };

let phase: PublishPhase = { step: "idle" };
const listeners = new Set<() => void>();

export function getPublishPhase(): PublishPhase {
    return phase;
}

export function setPublishPhase(next: PublishPhase): void {
    phase = next;
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            // um assinante quebrado não bloqueia os outros
        }
    }
}

export function isPublishStarting(): boolean {
    return phase.step !== "idle";
}

export function subscribePublishPhase(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

const TRANSPORT_LABEL: Record<ScreenTransport, string> = {
    cloudflare: "Cloudflare",
    mediamtx: "servidor próprio (MediaMTX)"
};

/** Texto curto do que está acontecendo, para mostrar ao lado do carregamento. */
export function describePhase(value: PublishPhase): string {
    switch (value.step) {
        case "room":
            return "Abrindo a sala…";
        case "capture":
            return "Preparando a captura da tela…";
        case "connecting": {
            const where = TRANSPORT_LABEL[value.transport];
            return value.total > 1 && value.attempt > 1
                ? `Tentando outro caminho: ${where}…`
                : `Conectando pelo ${where}…`;
        }
        default:
            return "";
    }
}
