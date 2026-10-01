/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { createButecoStore } from "./store";

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
});
