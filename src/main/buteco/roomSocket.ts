/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BUTECO_WEB_ORIGIN, type ButecoWebEvent, mapLobbyRooms, mapRoomState } from "shared/butecoWeb";
import { io as defaultIo } from "socket.io-client";

export interface CreateRoomSocketOptions {
    /** Header Cookie da sessão web; `null` conecta sem autenticação (não deve ocorrer). */
    cookieHeader: string | null;
    ioImpl?: typeof defaultIo;
    onEvent: (event: ButecoWebEvent) => void;
}

export interface RoomSocket {
    getSocketId(): string | null;
    subscribeLobby(): void;
    join(roomId: string, password?: string): void;
    create(name: string, password?: string): void;
    leave(): void;
    close(): void;
}

/**
 * Socket.IO do site (namespace default), autenticado por cookie via
 * `extraHeaders` — suportado pelo transport websocket do engine.io-client no
 * Node. O `socketId` é o identificador usado nos pedidos WHIP/WHEP.
 */
export function createRoomSocket(opts: CreateRoomSocketOptions): RoomSocket {
    const ioImpl = opts.ioImpl ?? defaultIo;
    const socket = ioImpl(BUTECO_WEB_ORIGIN, {
        withCredentials: true,
        transports: ["websocket", "polling"],
        ...(opts.cookieHeader ? { extraHeaders: { Cookie: opts.cookieHeader } } : {})
    });

    socket.on("connect", () => {
        socket.emit("screenshare:subscribe");
    });

    socket.on("screenshare:lobby", (payload: unknown) => {
        opts.onEvent({ type: "lobby", rooms: mapLobbyRooms(payload) });
    });

    socket.on("screenshare:state", (payload: unknown) => {
        const room = mapRoomState(payload);
        if (room) opts.onEvent({ type: "room", room });
    });

    socket.on("screenshare:join_denied", (payload: any) => {
        opts.onEvent({ type: "join-denied", reason: payload?.reason });
    });

    socket.on("screenshare:closed", () => {
        opts.onEvent({ type: "room-closed" });
    });

    socket.on("screenshare:replaced", () => {
        opts.onEvent({ type: "room-closed", reason: "replaced" });
    });

    return {
        getSocketId: () => socket.id ?? null,
        subscribeLobby: () => socket.emit("screenshare:subscribe"),
        join: (roomId, password) =>
            socket.emit("screenshare:join", { roomId, password: password ?? "", watchReason: "choice" }),
        create: (name, password) => socket.emit("screenshare:create", { name, password: password ?? "" }),
        leave: () => socket.emit("screenshare:leave"),
        close: () => {
            socket.removeAllListeners?.();
            socket.disconnect();
        }
    };
}
