/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoRoomState, ButecoWebEnvelope } from "shared/butecoWeb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAutoCreatedRoom, ensureButecoRoom, getAutoCreatedRoomId, randomRoomName } from "./room";
import { applyButecoWebEnvelope, getButecoWebState, resetButecoWebState } from "./webState";

function room(roomId: string, members: ButecoRoomState["members"] = []): ButecoRoomState {
    return {
        roomId,
        name: roomId,
        members,
        screenAudioAllowed: true,
        screenTransport: "mediamtx",
        quality: "economica"
    };
}

function envelope(patch: Partial<ReturnType<typeof getButecoWebState>>): ButecoWebEnvelope {
    return { state: { ...getButecoWebState(), ...patch } };
}

function login() {
    applyButecoWebEnvelope(envelope({ status: { loggedIn: true, user: { id: "me", displayName: "Eu" } } }));
}

const web = {
    createRoom: vi.fn(),
    leaveRoom: vi.fn()
};

describe("randomRoomName", () => {
    it("builds a short name from a word and four digits, without needing a password", () => {
        expect(randomRoomName(() => 0)).toBe("Chopp 1000");
        expect(randomRoomName(() => 0.999999)).toMatch(/^[^\d]+ \d{4}$/);
        expect(randomRoomName().length).toBeLessThanOrEqual(48);
    });
});

describe("ensureButecoRoom", () => {
    beforeEach(() => {
        resetButecoWebState();
        clearAutoCreatedRoom();
        web.createRoom.mockReset().mockResolvedValue({ ok: true, value: undefined });
        web.leaveRoom.mockReset().mockResolvedValue({ ok: true, value: undefined });
        vi.stubGlobal("VesktopNative", { buteco: { web } });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("does nothing when already in a room", async () => {
        login();
        applyButecoWebEnvelope(envelope({ room: room("r1") }));

        expect(await ensureButecoRoom()).toEqual({ ok: true, value: undefined });
        expect(web.createRoom).not.toHaveBeenCalled();
    });

    it("refuses without a login", async () => {
        const result = await ensureButecoRoom();
        expect(result.ok).toBe(false);
        expect(web.createRoom).not.toHaveBeenCalled();
    });

    it("creates a random room without password and waits for the server state", async () => {
        login();
        const pending = ensureButecoRoom();
        await vi.waitFor(() => expect(web.createRoom).toHaveBeenCalled());

        const [name, password] = web.createRoom.mock.calls[0];
        expect(name).toMatch(/^\S+ \d{4}$/);
        expect(password).toBe("");

        applyButecoWebEnvelope(envelope({ room: room("novo") }));
        expect(await pending).toEqual({ ok: true, value: undefined });
        expect(getAutoCreatedRoomId()).toBe("novo");
    });

    it("surfaces the join error and times out when the room never opens", async () => {
        login();
        const refused = ensureButecoRoom();
        await vi.waitFor(() => expect(web.createRoom).toHaveBeenCalled());
        applyButecoWebEnvelope(envelope({ joinError: "Calma aí!" }));
        const result = await refused;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toBe("Calma aí!");

        resetButecoWebState();
        login();
        vi.useFakeTimers();
        const stuck = ensureButecoRoom();
        await vi.advanceTimersByTimeAsync(9000);
        const timedOut = await stuck;
        expect(timedOut.ok).toBe(false);
    });

    it("leaves a room where someone else is sharing, but only for exclusive requests", async () => {
        login();
        const busy = room("alheia", [{ userId: "outro", displayName: "Outro", screenId: "s1" }]);
        applyButecoWebEnvelope(envelope({ room: busy }));

        expect((await ensureButecoRoom()).ok).toBe(true);
        expect(web.leaveRoom).not.toHaveBeenCalled();

        const exclusive = ensureButecoRoom({ exclusive: true });
        await vi.waitFor(() => expect(web.createRoom).toHaveBeenCalled());
        expect(web.leaveRoom).toHaveBeenCalledTimes(1);

        // A sala antiga ainda chega depois do leave: não conta como a nova.
        applyButecoWebEnvelope(envelope({ room: busy }));
        applyButecoWebEnvelope(envelope({ room: room("minha") }));
        expect((await exclusive).ok).toBe(true);
        expect(getAutoCreatedRoomId()).toBe("minha");
    });
});
