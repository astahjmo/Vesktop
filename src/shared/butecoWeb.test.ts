/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { mapJoinDeniedMessage, mapLobbyRooms, mapRoomState } from "./butecoWeb";

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

    it("keeps owner, members and who is sharing the screen", () => {
        const [room] = mapLobbyRooms([
            {
                roomId: "r1",
                name: "Mesa",
                ownerId: "u1",
                ownerName: "Ana",
                screenOwnerId: "u2",
                members: [{ userId: "u2", displayName: "Beto", avatar: "a.png" }, { userId: 3 }, null]
            },
            { roomId: "r2", name: "Vazia", screenOwnerId: null }
        ]);
        expect(room).toMatchObject({ ownerId: "u1", ownerName: "Ana", screenOwnerId: "u2" });
        expect(room.members).toEqual([{ userId: "u2", displayName: "Beto", avatar: "a.png" }]);
        expect(mapLobbyRooms([{ roomId: "r2", name: "Vazia", screenOwnerId: null }])[0].screenOwnerId).toBeNull();
    });

    it("accepts a { rooms } wrapper and rejects garbage", () => {
        expect(mapLobbyRooms({ rooms: [{ roomId: "r1", name: "Mesa" }] })).toHaveLength(1);
        expect(mapLobbyRooms(undefined)).toEqual([]);
        expect(mapLobbyRooms("lol")).toEqual([]);
    });
});

describe("mapRoomState camera and quality", () => {
    it("keeps cameraId and the room quality with safe defaults", () => {
        const room = mapRoomState({
            roomId: "r1",
            members: [{ userId: "u1", cameraId: "c1" }, { userId: "u2" }],
            quality: "alta"
        });
        expect(room?.members.map(member => member.cameraId)).toEqual(["c1", null]);
        expect(room?.quality).toBe("alta");
        expect(mapRoomState({ roomId: "r2", members: [], quality: "x" })?.quality).toBe("economica");
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

describe("mapJoinDeniedMessage", () => {
    it("maps the known reasons to short PT messages", () => {
        expect(mapJoinDeniedMessage("password")).toBe("Senha incorreta.");
        expect(mapJoinDeniedMessage("WRONG_PASSWORD")).toBe("Senha incorreta.");
        expect(mapJoinDeniedMessage("full")).toBe("Sala cheia.");
        expect(mapJoinDeniedMessage("not_found")).toBe("Sala indisponível.");
    });

    it("falls back to a generic denial for unknown/absent reasons", () => {
        expect(mapJoinDeniedMessage(undefined)).toBe("Entrada negada.");
        expect(mapJoinDeniedMessage(42)).toBe("Entrada negada.");
        expect(mapJoinDeniedMessage("whatever")).toBe("Entrada negada.");
    });
});
