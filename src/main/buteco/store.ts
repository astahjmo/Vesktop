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
    /** Subscribes to state snapshots; the callback fires after every mutation. */
    subscribe(cb: (state: ButecoState) => void): () => void;
    clear(): void;
}

/** Session as seen by the renderer: everything except the bearer token. */
export type ButecoWireSession = Omit<ButecoSession, "token">;

/** State snapshot safe to cross the IPC boundary (no bearer token). */
export interface ButecoWireState extends Omit<ButecoState, "session"> {
    session: ButecoWireSession | null;
}

/** Event as seen by the renderer: a `session` event has its token stripped. */
export type ButecoWireEvent =
    Exclude<ButecoEvent, { type: "session" }> | { type: "session"; session: ButecoWireSession };

/** Envelope pushed on `BUTECO_EVENT`: the snapshot plus any event just forwarded. */
export interface ButecoEventEnvelope {
    state: ButecoWireState;
    event: ButecoWireEvent | undefined;
    /**
     * Optional control message carried alongside a snapshot. `"stop"` asks the
     * renderer to tear down the active Buteco publish (local tracks, peer
     * connection, virtmic); main also ends the SFU stream itself so the stream
     * stops even when the renderer is unresponsive.
     */
    control?: "stop";
}

/** The single redaction rule: strips the bearer token from a session. */
export function redactSession(session: ButecoSession): ButecoWireSession {
    const { token, ...rest } = session;
    return rest;
}

/** Strips the bearer token from a store snapshot so it never reaches the renderer. */
export function toWireState(state: ButecoState): ButecoWireState {
    if (!state.session) return { ...state, session: null };
    return { ...state, session: redactSession(state.session) };
}

/** Strips the bearer token from an event's session before it reaches the renderer. */
export function toWireEvent(event: ButecoEvent): ButecoWireEvent {
    if (event.type === "session") return { type: "session", session: redactSession(event.session) };
    return event;
}

export function createButecoStore(): ButecoStore {
    let state: ButecoState = { phase: "idle", session: null, publishing: false };
    const listeners = new Set<(event: ButecoEvent) => void>();
    const stateListeners = new Set<(state: ButecoState) => void>();

    /** Applies a state mutation and notifies subscribers with the new snapshot. */
    function mutate(next: ButecoState) {
        state = next;
        stateListeners.forEach(cb => cb(state));
    }

    return {
        getState: () => state,
        setPhase: phase => mutate({ ...state, phase }),
        setSession: session => mutate({ ...state, session }),
        setPublishing: publishing => mutate({ ...state, publishing }),
        emitEvent: event => listeners.forEach(cb => cb(event)),
        onEvent(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        subscribe(cb) {
            stateListeners.add(cb);
            return () => stateListeners.delete(cb);
        },
        clear: () => mutate({ phase: "idle", session: null, publishing: false })
    };
}

export const butecoStore = createButecoStore();
