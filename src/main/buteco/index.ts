/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { desktopCapturer, webContents } from "electron";
import type { ButecoEvent, ButecoPhase, ButecoPublishMeta, ButecoResult, ButecoSource } from "shared/buteco";
import { IpcEvents } from "shared/IpcEvents";

import { handle } from "../utils/ipcWrappers";
import { isWayland } from "../utils/isWayland";
import { armCapture, cancelCapture } from "./capture";
import { exchangeCode, tokenVault } from "./pairing";
import { connectHelper, type HelperConnection, safeSendStatus } from "./socket";
import { cacheSources, WAYLAND_PLACEHOLDER_ID, WAYLAND_SOURCE_LABEL } from "./sources";
import { createButecoStopper } from "./stop";
import {
    type ButecoEventEnvelope,
    butecoStore,
    type ButecoWireSession,
    redactSession,
    toWireEvent,
    toWireState
} from "./store";
import { publishScreen, refreshIce, unpair, unpublishScreen } from "./whip";

let helper: HelperConnection | null = null;

/**
 * Pushes the current store snapshot to every webContents, redacting the bearer
 * token via `toWireState`. When an event has just been forwarded it rides along
 * in the envelope, redacted through `toWireEvent` (a `session` event's token is
 * stripped by the same rule), so the renderer can react to
 * revoked/stop_requested/screen_lost. `control: "stop"` additionally asks the
 * renderer to tear down the active Buteco capture.
 *
 * Each send is guarded: `webContents.getAllWebContents()` can return windows
 * whose renderer died mid-iteration (a crashed/closed window must not abort the
 * broadcast nor escape into a socket.io event handler).
 */
function broadcast(event?: ButecoEvent, control?: "stop") {
    const envelope: ButecoEventEnvelope = {
        state: toWireState(butecoStore.getState()),
        event: event === undefined ? undefined : toWireEvent(event),
        ...(control === undefined ? {} : { control })
    };
    for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        try {
            wc.send(IpcEvents.BUTECO_EVENT, envelope);
        } catch {
            // A renderer can die between the isDestroyed check and send().
        }
    }
}

/**
 * Mirrors a phase transition to the helper socket, applying the store change
 * first so the two cannot diverge. `safeSendStatus` swallows transport errors;
 * the store writes are guarded so a throwing subscriber cannot escape into the
 * socket.io dispatch that triggered them.
 */
function setPhaseAndReport(phase: ButecoPhase) {
    try {
        butecoStore.setPhase(phase);
    } catch {
        // State is applied before subscribers run; keep the helper in sync.
    }
    safeSendStatus(helper, phase);
}

function connectSocket() {
    helper?.close();
    const session = tokenVault.getSession();
    if (!session) return;

    helper = connectHelper({
        url: session.socket.url,
        token: session.token,
        onEvent: event => {
            try {
                butecoStore.emitEvent(event);
                if (event.type === "revoked" || event.type === "stop_requested" || event.type === "screen_lost") {
                    butecoStore.setPublishing(false);
                    setPhaseAndReport("idle");
                } else if (event.type === "connection") {
                    // Re-report the current phase on every connectivity change:
                    // on connect this flushes any pending status; while offline
                    // it re-arms the single pending slot for the next connect.
                    safeSendStatus(helper, butecoStore.getState().phase);
                }
                broadcast(event);
            } catch {
                // A socket.io dispatch must never throw out of onEvent.
            }
        }
    });

    // Advertise the current phase to the freshly created connection. If the
    // socket is not yet connected this becomes its single pending status; the
    // client flushes it once the handshake completes.
    safeSendStatus(helper, butecoStore.getState().phase);
}

/**
 * Ends the active Buteco stream from the main process (tray stop path). The core
 * lives in `./stop` so it is unit-testable without an Electron mock; the store
 * flag is cleared before the Ground `DELETE` so the tray item hides at once and
 * re-entrant clicks are ignored.
 */
const butecoStopper = createButecoStopper({
    store: butecoStore,
    getToken: () => tokenVault.getToken(),
    unpublish: token => unpublishScreen({ token }),
    broadcast: control => broadcast(undefined, control)
});

export function stopButecoPublish(): Promise<void> {
    return butecoStopper.stop();
}

export function registerButeco() {
    handle(IpcEvents.BUTECO_PAIR, async (_, code: string): Promise<ButecoResult<ButecoWireSession>> => {
        setPhaseAndReport("pairing");
        const res = await exchangeCode(code);
        if (res.ok) {
            tokenVault.set(res.value);
            butecoStore.setSession(res.value);
            setPhaseAndReport("ready");
            connectSocket();
            broadcast();
            return { ok: true, value: redactSession(res.value) };
        }
        setPhaseAndReport("idle");
        broadcast();
        return res;
    });

    handle(IpcEvents.BUTECO_UNPAIR, async () => {
        const token = tokenVault.getToken();
        safeSendStatus(helper, "idle");
        helper?.close();
        helper = null;
        if (token) await unpair({ token });
        tokenVault.clear();
        butecoStore.clear();
        broadcast();
        return { ok: true, value: undefined };
    });

    handle(IpcEvents.BUTECO_ARM_CAPTURE, (_, sourceId: string) => armCapture(sourceId));
    handle(IpcEvents.BUTECO_CANCEL_CAPTURE, () => cancelCapture());

    handle(IpcEvents.BUTECO_LIST_SOURCES, async (): Promise<ButecoSource[]> => {
        // On Wayland the portal picker happens when the capture starts, so
        // enumerating sources here would only add an extra chooser dialog.
        if (isWayland) {
            return [{ id: WAYLAND_PLACEHOLDER_ID, name: WAYLAND_SOURCE_LABEL, kind: "screen" }];
        }

        const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 320, height: 180 }
        });
        // Keep the enumeration for the armed capture handler so it does not
        // have to call getSources again (see sources.ts).
        cacheSources(sources);
        return sources.map(s => ({
            id: s.id,
            name: s.name,
            kind: s.id.startsWith("screen:") ? "screen" : "window",
            thumbnailDataUrl: s.thumbnail.isEmpty() ? undefined : s.thumbnail.toDataURL()
        }));
    });

    handle(IpcEvents.BUTECO_PUBLISH, async (_, offerSdp: string, meta: ButecoPublishMeta) => {
        const token = tokenVault.getToken();
        if (!token) return { ok: false, error: { code: "token_invalid", message: "Sem sessão." } };
        setPhaseAndReport("starting");
        const res = await publishScreen({ token, offerSdp, meta });
        if (res.ok) {
            butecoStore.setPublishing(true);
            setPhaseAndReport("live");
        } else {
            butecoStore.setPublishing(false);
            setPhaseAndReport("idle");
        }
        broadcast();
        return res;
    });

    handle(IpcEvents.BUTECO_UNPUBLISH, async () => {
        const token = tokenVault.getToken();
        setPhaseAndReport("stopping");
        const res = token ? await unpublishScreen({ token }) : ({ ok: true, value: undefined } as const);
        butecoStore.setPublishing(false);
        setPhaseAndReport("idle");
        broadcast();
        return res;
    });

    handle(IpcEvents.BUTECO_REFRESH_ICE, async () => {
        const token = tokenVault.getToken();
        if (!token) return { ok: false, error: { code: "token_invalid", message: "Sem sessão." } };
        return refreshIce({ token });
    });
}

export { butecoStore };
