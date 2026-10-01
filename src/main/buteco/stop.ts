/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoStore } from "./store";

/**
 * Everything the stop flow needs, injected so the core is free of Electron and
 * can be unit-tested directly.
 */
export interface ButecoStopDeps {
    store: Pick<ButecoStore, "getState" | "setPublishing" | "setPhase">;
    /** Bearer token held by the vault, or null when no session exists. */
    getToken(): string | null;
    /** Ends the SFU stream (the Ground `DELETE /screen`); failures are swallowed. */
    unpublish(token: string): Promise<unknown>;
    /**
     * Pushes a snapshot to the renderer. `control: "stop"` additionally asks the
     * renderer to tear down its local capture (tracks / peer connection / virtmic).
     */
    broadcast(control?: "stop"): void;
}

export interface ButecoStopper {
    stop(): Promise<void>;
}

/**
 * Builds the main-process "stop the active Buteco publish" action.
 *
 * The publishing flag is cleared *before* the network round-trip so the tray
 * stop item disappears at once, and a re-entrant call (a second tray click while
 * a slow or hung `DELETE` is still in flight) is ignored instead of firing a
 * duplicate request. The Ground unpublish still runs with the main-held token, so
 * the stream ends even when the renderer is unresponsive.
 */
export function createButecoStopper(deps: ButecoStopDeps): ButecoStopper {
    let stoppingInFlight = false;

    return {
        async stop(): Promise<void> {
            if (stoppingInFlight) return;
            if (!deps.store.getState().publishing) return;

            stoppingInFlight = true;

            // Flip the flag synchronously, before awaiting anything: the tray item
            // hides immediately and a concurrent click sees `publishing === false`.
            deps.store.setPublishing(false);
            deps.store.setPhase("stopping");
            deps.broadcast("stop");

            try {
                const token = deps.getToken();
                if (token) await deps.unpublish(token).catch(() => {});
            } finally {
                deps.store.setPhase("idle");
                stoppingInFlight = false;
            }
        }
    };
}
