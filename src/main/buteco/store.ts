/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoEvent, ButecoPhase, ButecoSession } from "shared/buteco";

export interface ButecoState {
    phase: ButecoPhase;
    session: ButecoSession | null;
    publishing: boolean;
}

export interface ButecoStore {
    getState(): ButecoState;
    setPhase(phase: ButecoPhase): void;
    setSession(session: ButecoSession | null): void;
    setPublishing(value: boolean): void;
    emitEvent(event: ButecoEvent): void;
    onEvent(cb: (event: ButecoEvent) => void): () => void;
    clear(): void;
}

/** Session as seen by the renderer: everything except the bearer token. */
export type ButecoWireSession = Omit<ButecoSession, "token">;

/** State snapshot safe to cross the IPC boundary (no bearer token). */
export interface ButecoWireState extends Omit<ButecoState, "session"> {
    session: ButecoWireSession | null;
}

/** Envelope pushed on `BUTECO_EVENT`: the snapshot plus any event just forwarded. */
export interface ButecoEventEnvelope {
    state: ButecoWireState;
    event: ButecoEvent | undefined;
}

/** Strips the bearer token from a store snapshot so it never reaches the renderer. */
export function toWireState(state: ButecoState): ButecoWireState {
    if (!state.session) return { ...state, session: null };
    const { token, ...session } = state.session;
    return { ...state, session };
}

export function createButecoStore(): ButecoStore {
    let state: ButecoState = { phase: "idle", session: null, publishing: false };
    const listeners = new Set<(event: ButecoEvent) => void>();

    return {
        getState: () => state,
        setPhase: phase => (state = { ...state, phase }),
        setSession: session => (state = { ...state, session }),
        setPublishing: publishing => (state = { ...state, publishing }),
        emitEvent: event => listeners.forEach(cb => cb(event)),
        onEvent(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        clear: () => (state = { phase: "idle", session: null, publishing: false })
    };
}

export const butecoStore = createButecoStore();
