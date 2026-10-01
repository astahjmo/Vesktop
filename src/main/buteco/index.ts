/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { desktopCapturer, webContents } from "electron";
import type { ButecoEvent, ButecoPublishMeta, ButecoResult, ButecoSource } from "shared/buteco";
import { IpcEvents } from "shared/IpcEvents";

import { handle } from "../utils/ipcWrappers";
import { armCapture, cancelCapture } from "./capture";
import { exchangeCode, tokenVault } from "./pairing";
import { connectHelper, type HelperConnection } from "./socket";
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
 */
function broadcast(event?: ButecoEvent, control?: "stop") {
    const envelope: ButecoEventEnvelope = {
        state: toWireState(butecoStore.getState()),
        event: event === undefined ? undefined : toWireEvent(event),
        ...(control === undefined ? {} : { control })
    };
    for (const wc of webContents.getAllWebContents()) {
        wc.send(IpcEvents.BUTECO_EVENT, envelope);
    }
}

function connectSocket() {
    helper?.close();
    const session = tokenVault.getSession();
    if (!session) return;

    helper = connectHelper({
        url: session.socket.url,
        token: session.token,
        onEvent: event => {
            butecoStore.emitEvent(event);
            if (event.type === "revoked" || event.type === "stop_requested" || event.type === "screen_lost") {
                butecoStore.setPublishing(false);
                butecoStore.setPhase("idle");
            }
            broadcast(event);
        }
    });
}

/**
 * Ends the active Buteco stream from the main process. Best-effort: it asks the
 * Ground to delete the screen resource (so the stream ends even if the renderer
 * is unresponsive) and always asks the renderer to tear down its local capture
 * via `control: "stop"` on `BUTECO_EVENT`. No-op when nothing is publishing.
 */
export async function stopButecoPublish(): Promise<void> {
    if (!butecoStore.getState().publishing) return;

    const token = tokenVault.getToken();
    if (token) await unpublishScreen({ token }).catch(() => {});

    butecoStore.setPublishing(false);
    butecoStore.setPhase("idle");
    broadcast(undefined, "stop");
}

export function registerButeco() {
    handle(IpcEvents.BUTECO_PAIR, async (_, code: string): Promise<ButecoResult<ButecoWireSession>> => {
        butecoStore.setPhase("pairing");
        const res = await exchangeCode(code);
        if (res.ok) {
            tokenVault.set(res.value);
            butecoStore.setSession(res.value);
            butecoStore.setPhase("ready");
            connectSocket();
            broadcast();
            return { ok: true, value: redactSession(res.value) };
        }
        butecoStore.setPhase("idle");
        broadcast();
        return res;
    });

    handle(IpcEvents.BUTECO_UNPAIR, async () => {
        const token = tokenVault.getToken();
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
        const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 320, height: 180 }
        });
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
        butecoStore.setPhase("starting");
        const res = await publishScreen({ token, offerSdp, meta });
        if (res.ok) {
            butecoStore.setPublishing(true);
            butecoStore.setPhase("live");
        } else {
            butecoStore.setPublishing(false);
            butecoStore.setPhase("idle");
        }
        broadcast();
        return res;
    });

    handle(IpcEvents.BUTECO_UNPUBLISH, async () => {
        const token = tokenVault.getToken();
        butecoStore.setPhase("stopping");
        const res = token ? await unpublishScreen({ token }) : ({ ok: true, value: undefined } as const);
        butecoStore.setPublishing(false);
        butecoStore.setPhase("idle");
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
