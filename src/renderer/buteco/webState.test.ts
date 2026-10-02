/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    applyButecoWebEnvelope,
    findRoomStream,
    getButecoWebState,
    resetButecoWebState,
    subscribeButecoWeb
} from "./webState";

describe("findRoomStream", () => {
    it("returns the first member with an active screen", () => {
        const member = findRoomStream({
            roomId: "r1",
            name: "Mesa",
            members: [
                { userId: "u1", displayName: "Ana" },
                { userId: "u2", displayName: "Bia", screenId: "s1" }
            ],
            screenAudioAllowed: true,
            screenTransport: "mediamtx",
            quality: "economica"
        });
        expect(member?.userId).toBe("u2");
    });

    it("returns null without a room or stream", () => {
        expect(findRoomStream(null)).toBeNull();
        expect(
            findRoomStream({
                roomId: "r1",
                name: "Mesa",
                members: [{ userId: "u1", displayName: "Ana", screenId: null }],
                screenAudioAllowed: true,
                screenTransport: "mediamtx",
                quality: "economica"
            })
        ).toBeNull();
    });
});

describe("butecoWebState", () => {
    beforeEach(() => resetButecoWebState());

    it("applies an envelope and notifies subscribers", () => {
        const cb = vi.fn();
        subscribeButecoWeb(cb);
        applyButecoWebEnvelope({
            state: {
                status: { loggedIn: true, user: { id: "u1", displayName: "Ana" } },
                lobby: [],
                room: null,
                joinError: null
            },
            event: { type: "status", status: { loggedIn: true, user: { id: "u1", displayName: "Ana" } } }
        });
        expect(getButecoWebState().status.loggedIn).toBe(true);
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it("carries a join error in the envelope state", () => {
        applyButecoWebEnvelope({
            state: {
                status: { loggedIn: true, user: null },
                lobby: [],
                room: null,
                joinError: "Senha incorreta."
            }
        });
        expect(getButecoWebState().joinError).toBe("Senha incorreta.");
    });

    it("ignores malformed envelopes", () => {
        const cb = vi.fn();
        subscribeButecoWeb(cb);
        applyButecoWebEnvelope(undefined as any);
        expect(cb).not.toHaveBeenCalled();
    });
});
