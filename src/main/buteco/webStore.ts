/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoWebEvent, ButecoWebState } from "shared/butecoWeb";

export interface ButecoWebStore {
    getState(): ButecoWebState;
    patch(partial: Partial<ButecoWebState>): void;
    emitEvent(event: ButecoWebEvent): void;
    onEvent(cb: (event: ButecoWebEvent) => void): () => void;
}

export function createButecoWebStore(): ButecoWebStore {
    let state: ButecoWebState = { status: { loggedIn: false, user: null }, lobby: null, room: null };
    const listeners = new Set<(event: ButecoWebEvent) => void>();

    return {
        getState: () => state,
        patch: partial => (state = { ...state, ...partial }),
        emitEvent: event => listeners.forEach(cb => cb(event)),
        onEvent(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        }
    };
}

export const butecoWebStore = createButecoWebStore();
