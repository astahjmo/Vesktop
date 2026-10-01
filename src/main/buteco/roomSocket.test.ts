/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { createRoomSocket } from "./roomSocket";

function fakeIo() {
    const handlers = new Map<string, Function>();
    const emitted: Array<[string, unknown]> = [];
    const socket = {
        id: "sock-1",
        on: (event: string, cb: Function) => handlers.set(event, cb),
        emit: (event: string, payload?: unknown) => emitted.push([event, payload]),
        disconnect: vi.fn(),
        removeAllListeners: vi.fn(),
        fire: (event: string, payload?: unknown) => handlers.get(event)?.(payload)
    };
    const io = vi.fn(() => socket) as any;
    return { io, socket, emitted };
}

describe("createRoomSocket", () => {
    it("connects with cookie header and subscribes the lobby on connect", () => {
        const { io, socket, emitted } = fakeIo();
        createRoomSocket({ cookieHeader: "c=1", ioImpl: io, onEvent: () => {} });

        expect(io).toHaveBeenCalledWith(
            "https://games.butecodosdevs.com",
            expect.objectContaining({ transports: ["websocket", "polling"], extraHeaders: { Cookie: "c=1" } })
        );

        socket.fire("connect");
        expect(emitted).toContainEqual(["screenshare:subscribe", undefined]);
    });

    it("forwards lobby and room state", () => {
        const { io, socket } = fakeIo();
        const events: any[] = [];
        createRoomSocket({ cookieHeader: null, ioImpl: io, onEvent: e => events.push(e) });

        socket.fire("screenshare:lobby", [{ roomId: "r1", name: "Mesa", memberCount: 2, hasPassword: false }]);
        socket.fire("screenshare:state", {
            roomId: "r1",
            name: "Mesa",
            members: [{ userId: "u1", displayName: "Ana" }]
        });
        socket.fire("screenshare:closed");
        socket.fire("screenshare:join_denied", { reason: "password" });

        expect(events[0]).toEqual({
            type: "lobby",
            rooms: [{ roomId: "r1", name: "Mesa", memberCount: 2, hasPassword: false }]
        });
        expect(events[1].type).toBe("room");
        expect(events[1].room.roomId).toBe("r1");
        expect(events[2]).toEqual({ type: "room-closed" });
        expect(events[3]).toEqual({ type: "join-denied", reason: "password" });
    });

    it("joins with watchReason choice and exposes the socket id", () => {
        const { io, socket, emitted } = fakeIo();
        const ctrl = createRoomSocket({ cookieHeader: null, ioImpl: io, onEvent: () => {} });
        ctrl.join("r1", "abc");
        expect(emitted).toContainEqual(["screenshare:join", { roomId: "r1", password: "abc", watchReason: "choice" }]);
        expect(ctrl.getSocketId()).toBe("sock-1");
        ctrl.close();
        expect(socket.disconnect).toHaveBeenCalled();
    });

    it("emits room-closed/disconnected on transport drop but not on close()", () => {
        const { io, socket } = fakeIo();
        const events: any[] = [];
        const ctrl = createRoomSocket({ cookieHeader: null, ioImpl: io, onEvent: e => events.push(e) });

        socket.fire("disconnect");
        expect(events).toEqual([{ type: "room-closed", reason: "disconnected" }]);

        events.length = 0;
        ctrl.close();
        socket.fire("disconnect");
        expect(events).toEqual([]);
    });
});
