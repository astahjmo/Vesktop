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
 * O WAF/servidor do site rejeita o handshake sem `Origin` + `User-Agent` de
 * navegador (recebemos `Forbidden` no namespace mesmo com o cookie correto).
 * Um UA estável de Chrome desktop é suficiente.
 */
const BROWSER_USER_AGENT =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

/**
 * Socket.IO do site (namespace default), autenticado por cookie via
 * `extraHeaders` — suportado pelos transports do engine.io-client no Node
 * (websocket e polling). O `socketId` é o identificador usado nos pedidos
 * WHIP/WHEP.
 */
export function createRoomSocket(opts: CreateRoomSocketOptions): RoomSocket {
    const ioImpl = opts.ioImpl ?? defaultIo;
    const socket = ioImpl(BUTECO_WEB_ORIGIN, {
        // `withCredentials` é um flag de browser: no Node ele liga um cookie jar
        // interno do engine.io-client que atropela o header Cookie explícito
        // (resultado: "Authentication required"). Aqui o cookie vai só no header.
        transports: ["websocket", "polling"],
        extraHeaders: {
            Origin: BUTECO_WEB_ORIGIN,
            "User-Agent": BROWSER_USER_AGENT,
            ...(opts.cookieHeader ? { Cookie: opts.cookieHeader } : {})
        }
    });

    // Diferencia a queda de transporte de um `close()` nosso: só a primeira
    // limpa a sala (e derruba a publicação ativa) no main.
    let closedByUs = false;

    socket.on("connect", () => {
        socket.emit("screenshare:subscribe");
    });

    socket.on("disconnect", () => {
        if (closedByUs) return;
        opts.onEvent({ type: "room-closed", reason: "disconnected" });
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
            closedByUs = true;
            socket.removeAllListeners?.();
            socket.disconnect();
        }
    };
}
