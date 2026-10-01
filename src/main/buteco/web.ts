/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { webContents } from "electron";
import type { ButecoWebEnvelope, ButecoWebEvent } from "shared/butecoWeb";
import { IpcEvents } from "shared/IpcEvents";

import { handle } from "../utils/ipcWrappers";
import { createRoomSocket, type RoomSocket } from "./roomSocket";
import { fetchWebIce, webCloseConnection, webPublishScreen, webReleaseScreen } from "./webApi";
import { getWebCookieHeader, getWebStatus, openWebLoginWindow } from "./webSession";
import { butecoWebStore } from "./webStore";

let roomSocket: RoomSocket | null = null;

function broadcast(event?: ButecoWebEvent) {
    const envelope: ButecoWebEnvelope = { state: butecoWebStore.getState(), event };
    for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        try {
            wc.send(IpcEvents.BUTECO_WEB_EVENT, envelope);
        } catch {
            // renderer pode morrer entre o check e o send
        }
    }
}

function handleRoomEvent(event: ButecoWebEvent) {
    switch (event.type) {
        case "lobby":
            butecoWebStore.patch({ lobby: event.rooms });
            break;
        case "room":
            butecoWebStore.patch({ room: event.room });
            break;
        case "room-closed":
            butecoWebStore.patch({ room: null });
            break;
        default:
            break;
    }
    broadcast(event);
}

async function ensureRoomSocket(): Promise<RoomSocket | null> {
    if (roomSocket) return roomSocket;
    const cookie = await getWebCookieHeader();
    if (!cookie) return null;
    roomSocket = createRoomSocket({ cookieHeader: cookie, onEvent: handleRoomEvent });
    return roomSocket;
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
        const socket = await ensureRoomSocket();
        if (!socket) {
            return { ok: false, error: { code: "token_invalid", message: "Entre no Buteco Games primeiro." } };
        }
        socket.join(roomId, password);
        return { ok: true, value: undefined };
    });

    handle(IpcEvents.BUTECO_ROOM_CREATE, async (_, name: string, password: string) => {
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
        broadcast({ type: "room", room: null });
        return { ok: true, value: undefined };
    });

    handle(IpcEvents.BUTECO_WEB_ICE, () => fetchWebIce());

    handle(IpcEvents.BUTECO_WEB_PUBLISH, async (_, sdp: string) => {
        const { room } = butecoWebStore.getState();
        const socketId = roomSocket?.getSocketId() ?? null;
        if (!room || !socketId) {
            return { ok: false, error: { code: "token_invalid", message: "Entre numa sala primeiro." } };
        }
        return webPublishScreen(room.roomId, socketId, sdp);
    });

    handle(IpcEvents.BUTECO_WEB_UNPUBLISH, async () => {
        const { room } = butecoWebStore.getState();
        const socketId = roomSocket?.getSocketId() ?? null;
        if (!room || !socketId) return { ok: true, value: undefined };
        const released = await webReleaseScreen(room.roomId, socketId);
        void webCloseConnection(room.roomId, socketId);
        return released;
    });
}
