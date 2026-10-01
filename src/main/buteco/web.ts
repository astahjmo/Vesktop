/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { webContents } from "electron";
import { type ButecoWebEnvelope, type ButecoWebEvent, mapJoinDeniedMessage } from "shared/butecoWeb";
import { IpcEvents } from "shared/IpcEvents";

import { handle } from "../utils/ipcWrappers";
import { createRoomSocket, type RoomSocket } from "./roomSocket";
import { butecoStore } from "./store";
import { fetchWebIce, webCloseConnection, webPublishScreen, webReleaseScreen } from "./webApi";
import { getWebCookieHeader, getWebStatus, openWebLoginWindow } from "./webSession";
import { butecoWebStore } from "./webStore";

let roomSocket: RoomSocket | null = null;
let roomSocketPromise: Promise<RoomSocket | null> | null = null;

/**
 * Associação da publicação web viva: `{ roomId, socketId }` do WHIP aceito.
 * Sobrevive a leave/closed/disconnect (ao contrário do estado da sala) para
 * que o stop saiba o que soltar, e é limpa exatamente uma vez.
 */
let activePublish: { roomId: string; socketId: string } | null = null;

function broadcast(event?: ButecoWebEvent, control?: "stop") {
    const envelope: ButecoWebEnvelope = {
        state: butecoWebStore.getState(),
        event,
        ...(control === undefined ? {} : { control })
    };
    for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        try {
            wc.send(IpcEvents.BUTECO_WEB_EVENT, envelope);
        } catch {
            // renderer pode morrer entre o check e o send
        }
    }
}

/**
 * Esquece a publicação web ativa e, quando existia, devolve o controle
 * `"stop"` para o renderer derrubar o controller local. Não chama a API de
 * release: quem chama isto já perdeu a sala (leave/closed/disconnect), e o
 * renderer só precisa parar a captura.
 */
function clearActivePublish(): "stop" | undefined {
    if (!activePublish) return undefined;
    activePublish = null;
    butecoStore.setPublishing(false);
    return "stop";
}

/** Sessão expirada (401 em qualquer chamada web): volta ao estado deslogado. */
function markSessionExpired() {
    const status = { loggedIn: false, user: null };
    butecoWebStore.patch({ status, room: null });
    broadcast({ type: "status", status });
}

function handleRoomEvent(event: ButecoWebEvent) {
    let control: "stop" | undefined;
    switch (event.type) {
        case "lobby":
            butecoWebStore.patch({ lobby: event.rooms });
            break;
        case "room":
            butecoWebStore.patch({ room: event.room, joinError: null });
            break;
        case "join-denied":
            butecoWebStore.patch({ joinError: mapJoinDeniedMessage(event.reason) });
            break;
        case "room-closed":
            butecoWebStore.patch({ room: null });
            control = clearActivePublish();
            break;
        default:
            break;
    }
    broadcast(event, control);
}

async function ensureRoomSocket(): Promise<RoomSocket | null> {
    if (roomSocket) return roomSocket;
    if (roomSocketPromise) return roomSocketPromise;

    roomSocketPromise = (async () => {
        try {
            const cookie = await getWebCookieHeader();
            if (!cookie) return null;
            roomSocket = createRoomSocket({ cookieHeader: cookie, onEvent: handleRoomEvent });
            return roomSocket;
        } finally {
            roomSocketPromise = null;
        }
    })();

    return roomSocketPromise;
}

export function registerButecoWeb() {
    handle(IpcEvents.BUTECO_WEB_STATUS, async () => {
        const status = await getWebStatus();
        butecoWebStore.patch({ status });
        broadcast({ type: "status", status });
        return status;
    });

    handle(IpcEvents.BUTECO_WEB_LOGIN, async () => {
        const status = await openWebLoginWindow();
        butecoWebStore.patch({ status });
        if (status.loggedIn) await ensureRoomSocket();
        broadcast({ type: "status", status });
        return status;
    });

    handle(IpcEvents.BUTECO_WEB_LOBBY, async () => {
        const socket = await ensureRoomSocket();
        socket?.subscribeLobby();
        return butecoWebStore.getState().lobby;
    });

    handle(IpcEvents.BUTECO_ROOM_JOIN, async (_, roomId: string, password: string) => {
        butecoWebStore.patch({ joinError: null });
        const socket = await ensureRoomSocket();
        if (!socket) {
            return { ok: false, error: { code: "token_invalid", message: "Entre no Buteco Games primeiro." } };
        }
        socket.join(roomId, password);
        return { ok: true, value: undefined };
    });

    handle(IpcEvents.BUTECO_ROOM_CREATE, async (_, name: string, password: string) => {
        butecoWebStore.patch({ joinError: null });
        const socket = await ensureRoomSocket();
        if (!socket) {
            return { ok: false, error: { code: "token_invalid", message: "Entre no Buteco Games primeiro." } };
        }
        socket.create(name, password);
        return { ok: true, value: undefined };
    });

    handle(IpcEvents.BUTECO_ROOM_LEAVE, () => {
        roomSocket?.leave();
        butecoWebStore.patch({ room: null });
        broadcast({ type: "room", room: null }, clearActivePublish());
        return { ok: true, value: undefined };
    });

    handle(IpcEvents.BUTECO_WEB_ICE, async () => {
        const res = await fetchWebIce();
        if (!res.ok && res.error.code === "token_invalid") markSessionExpired();
        return res;
    });

    handle(IpcEvents.BUTECO_WEB_PUBLISH, async (_, sdp: string) => {
        const { room } = butecoWebStore.getState();
        const socketId = roomSocket?.getSocketId() ?? null;
        if (!room || !socketId) {
            return { ok: false, error: { code: "token_invalid", message: "Entre numa sala primeiro." } };
        }
        const res = await webPublishScreen(room.roomId, socketId, sdp);
        if (res.ok) {
            activePublish = { roomId: room.roomId, socketId };
            butecoStore.setPublishing(true);
        } else if (res.error.code === "token_invalid") {
            markSessionExpired();
        }
        return res;
    });

    handle(IpcEvents.BUTECO_WEB_UNPUBLISH, async () => {
        const publish = activePublish;
        if (!publish) return { ok: true, value: undefined };

        // Limpa antes do round-trip: um stop re-entrante não solta duas vezes.
        activePublish = null;
        butecoStore.setPublishing(false);

        const released = await webReleaseScreen(publish.roomId, publish.socketId);
        if (!released.ok && released.error.code === "token_invalid") markSessionExpired();
        void webCloseConnection(publish.roomId, publish.socketId).catch(() => {});
        return released;
    });
}
