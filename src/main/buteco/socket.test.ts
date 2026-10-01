/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { connectHelper, safeSendStatus } from "./socket";

function fakeIo() {
    const handlers = new Map<string, Function>();
    const emitted: Array<[string, unknown]> = [];
    // `connected` is intentionally mutable so tests can simulate a dropped socket.
    const socket = {
        connected: true,
        io: { on: vi.fn() },
        on: (ev: string, cb: Function) => {
            handlers.set(ev, cb);
        },
        emit: (ev: string, payload?: unknown) => {
            emitted.push([ev, payload]);
        },
        disconnect: vi.fn(),
        fire: (ev: string, payload?: unknown) => handlers.get(ev)?.(payload)
    };
    const io = vi.fn(() => socket) as any;
    return { io, socket, emitted };
}

describe("connectHelper", () => {
    it("connects to the namespace with auth and protocol", () => {
        const { io } = fakeIo();
        connectHelper({ url: "https://g/", token: "t", ioImpl: io, onEvent: () => {} });
        expect(io).toHaveBeenCalledWith(
            "https://g/helper",
            expect.objectContaining({
                auth: { token: "t", protocol: 1 },
                transports: ["websocket"]
            })
        );
    });

    it("emits status at most once per second", () => {
        const { io, socket, emitted } = fakeIo();
        const ctrl = connectHelper({ url: "https://g", token: "t", ioImpl: io, onEvent: () => {} });
        socket.fire("connect");
        expect(ctrl.sendStatus("live", 1000)).toBe(true);
        expect(ctrl.sendStatus("live", 1500)).toBe(false);
        expect(emitted.filter(([e]) => e === "helper:status").length).toBe(1);
    });

    it("keeps a single pending status while disconnected and flushes it once on connect", () => {
        const { io, socket, emitted } = fakeIo();
        const ctrl = connectHelper({ url: "https://g", token: "t", ioImpl: io, onEvent: () => {} });
        socket.connected = false;

        // Disconnected: no emit, just a pending slot.
        expect(ctrl.sendStatus("live", 1000)).toBe(false);
        expect(emitted.filter(([e]) => e === "helper:status").length).toBe(0);

        // Still disconnected: single slot, latest phase wins, still no emit.
        expect(ctrl.sendStatus("ready", 1100)).toBe(false);
        expect(emitted.filter(([e]) => e === "helper:status").length).toBe(0);

        // Reconnect: the latest pending phase is flushed exactly once.
        socket.connected = true;
        socket.fire("connect");
        const statusEmits = emitted.filter(([e]) => e === "helper:status");
        expect(statusEmits).toEqual([["helper:status", "ready"]]);

        // The flush stamps lastStatusAt, so a send within 1s still respects the cap.
        expect(ctrl.sendStatus("selecting", 1200)).toBe(false);
        expect(emitted.filter(([e]) => e === "helper:status").length).toBe(1);
    });

    it("forwards session/revoked events", () => {
        const { io, socket } = fakeIo();
        const events: any[] = [];
        connectHelper({ url: "https://g", token: "t", ioImpl: io, onEvent: e => events.push(e) });
        socket.fire("connect");
        socket.fire("helper:revoked", { reason: "user_revoked" });
        socket.fire("helper:stop_requested", { by: "owner" });
        expect(events).toEqual([
            { type: "connection", state: "connected" },
            { type: "revoked", reason: "user_revoked" },
            { type: "stop_requested", by: "owner" }
        ]);
    });
});

describe("safeSendStatus", () => {
    it("is a no-op with no connection", () => {
        expect(safeSendStatus(null, "live")).toBe(false);
        expect(safeSendStatus(undefined, "idle")).toBe(false);
    });

    it("returns the connection's result", () => {
        const connection = { sendStatus: vi.fn(() => true), close: vi.fn() };
        expect(safeSendStatus(connection, "ready")).toBe(true);
        expect(connection.sendStatus).toHaveBeenCalledWith("ready");
    });

    it("swallows transport errors so a caller cannot throw", () => {
        const connection = {
            sendStatus: vi.fn(() => {
                throw new Error("socket closed");
            }),
            close: vi.fn()
        };
        expect(() => safeSendStatus(connection, "stopping")).not.toThrow();
        expect(safeSendStatus(connection, "stopping")).toBe(false);
    });
});
