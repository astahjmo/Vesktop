/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoWebEnvelope, ButecoWebState } from "shared/butecoWeb";

function initialState(): ButecoWebState {
    return { status: { loggedIn: false, user: null }, lobby: null, room: null, joinError: null };
}

let state: ButecoWebState = initialState();
const listeners = new Set<() => void>();

export function getButecoWebState(): ButecoWebState {
    return state;
}

export function resetButecoWebState(): void {
    state = initialState();
}

export function applyButecoWebEnvelope(envelope: ButecoWebEnvelope): void {
    if (!envelope?.state) return;

    state = envelope.state;
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            // um assinante quebrado não bloqueia os outros
        }
    }
}

export function subscribeButecoWeb(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
