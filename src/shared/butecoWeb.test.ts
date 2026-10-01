/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { mapLobbyRooms, mapRoomState } from "./butecoWeb";

describe("mapLobbyRooms", () => {
    it("maps a room array and tolerates missing fields", () => {
        const rooms = mapLobbyRooms([
            { roomId: "r1", name: "Mesa", memberCount: 3, hasPassword: true },
            { roomId: "r2", name: "Outra" },
            { nope: true },
            null
        ]);
        expect(rooms).toEqual([
            { roomId: "r1", name: "Mesa", memberCount: 3, hasPassword: true },
            { roomId: "r2", name: "Outra", memberCount: 0, hasPassword: false }
        ]);
    });

    it("accepts a { rooms } wrapper and rejects garbage", () => {
        expect(mapLobbyRooms({ rooms: [{ roomId: "r1", name: "Mesa" }] })).toHaveLength(1);
        expect(mapLobbyRooms(undefined)).toEqual([]);
        expect(mapLobbyRooms("lol")).toEqual([]);
    });
});

describe("mapRoomState", () => {
    it("maps members and defaults", () => {
        const room = mapRoomState({
            roomId: "r1",
            name: "Mesa",
            members: [
                { userId: "u1", displayName: "Ana", screenId: "s1", screenAudio: true, screenTransport: "mediamtx" },
                { userId: "u2" }
            ]
        });
        expect(room).not.toBeNull();
        expect(room!.name).toBe("Mesa");
        expect(room!.members).toHaveLength(2);
        expect(room!.members[0]).toMatchObject({ userId: "u1", displayName: "Ana", screenId: "s1", screenAudio: true });
        expect(room!.members[1]).toMatchObject({ userId: "u2", displayName: "u2", screenId: null, screenAudio: false });
        expect(room!.screenAudioAllowed).toBe(true);
        expect(room!.screenTransport).toBe("mediamtx");
    });

    it("returns null without a roomId and tolerates bad members", () => {
        expect(mapRoomState({ members: [] })).toBeNull();
        expect(mapRoomState(null)).toBeNull();
        const room = mapRoomState({ roomId: "r1", members: [{ foo: 1 }] });
        expect(room!.members).toEqual([]);
    });
});
