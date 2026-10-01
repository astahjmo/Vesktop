/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoSession } from "shared/buteco";
import { describe, expect, it, vi } from "vitest";

import { createButecoStore, toWireEvent, toWireState } from "./store";

const session: ButecoSession = {
    token: "super-secret-token",
    tokenExpiresAt: "2026-10-01T12:00:00.000Z",
    room: { id: "r1", slug: "sala", name: "Sala" },
    user: { id: "u1", displayName: "Dev" },
    socket: { url: "https://games.example.com", path: "/socket.io", namespace: "/helper" },
    iceServers: [{ urls: "stun:stun.example.com" }],
    limits: { screenAudioAllowed: false, maxHeight: 1080, maxFps: 60, maxVideoKbps: 6000, audioKbps: 128 },
    screen: { takenBy: null },
    serverNow: "2026-10-01T11:00:00.000Z"
};

describe("butecoStore", () => {
    it("tracks phase and session", () => {
        const store = createButecoStore();
        expect(store.getState().phase).toBe("idle");
        store.setPhase("live");
        expect(store.getState().phase).toBe("live");
    });

    it("forwards events to subscribers", () => {
        const store = createButecoStore();
        const cb = vi.fn();
        store.onEvent(cb);
        store.emitEvent({ type: "revoked", reason: "user_revoked" });
        expect(cb).toHaveBeenCalledWith({ type: "revoked", reason: "user_revoked" });
    });

    it("unsubscribes listeners", () => {
        const store = createButecoStore();
        const cb = vi.fn();
        const off = store.onEvent(cb);
        off();
        store.emitEvent({ type: "revoked", reason: "user_revoked" });
        expect(cb).not.toHaveBeenCalled();
    });
});

describe("toWireState", () => {
    it("strips the bearer token from the session", () => {
        const store = createButecoStore();
        store.setSession(session);
        const wire = toWireState(store.getState());
        expect(wire.session).not.toHaveProperty("token");
        expect(wire.session?.room.slug).toBe("sala");
        expect(wire.session?.socket.url).toBe("https://games.example.com");
        expect(wire.session?.iceServers).toHaveLength(1);
        expect(wire.session?.limits.maxFps).toBe(60);
    });

    it("leaves a null session untouched", () => {
        const wire = toWireState({ phase: "idle", session: null, publishing: false });
        expect(wire.session).toBeNull();
        expect(wire.phase).toBe("idle");
    });
});

describe("toWireEvent", () => {
    it("strips the bearer token from a session event", () => {
        const wire = toWireEvent({ type: "session", session });
        expect(wire.type).toBe("session");
        if (wire.type !== "session") throw new Error("expected session event");
        expect(wire.session).not.toHaveProperty("token");
        expect(wire.session.user.displayName).toBe("Dev");
        expect(wire.session.room.slug).toBe("sala");
        expect(wire.session.iceServers).toHaveLength(1);
    });

    it("passes non-session events through unchanged", () => {
        expect(toWireEvent({ type: "revoked", reason: "user_revoked" })).toEqual({
            type: "revoked",
            reason: "user_revoked"
        });
        expect(toWireEvent({ type: "connection", state: "reconnecting" })).toEqual({
            type: "connection",
            state: "reconnecting"
        });
    });
});
