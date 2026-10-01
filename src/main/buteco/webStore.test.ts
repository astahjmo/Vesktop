/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { createButecoWebStore } from "./webStore";

describe("butecoWebStore", () => {
    it("starts logged out with no lobby", () => {
        const store = createButecoWebStore();
        expect(store.getState()).toEqual({
            status: { loggedIn: false, user: null },
            lobby: null,
            room: null
        });
    });

    it("patches state and notifies subscribers", () => {
        const store = createButecoWebStore();
        const cb = vi.fn();
        store.onEvent(cb);
        store.patch({ lobby: [{ roomId: "r1", name: "Mesa", memberCount: 1, hasPassword: false }] });
        store.emitEvent({ type: "lobby", rooms: [] });
        expect(store.getState().lobby).toHaveLength(1);
        expect(cb).toHaveBeenCalledWith({ type: "lobby", rooms: [] });
    });
});
