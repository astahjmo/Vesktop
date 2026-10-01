/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyButecoWebEnvelope, getButecoWebState, resetButecoWebState, subscribeButecoWeb } from "./webState";

describe("butecoWebState", () => {
    beforeEach(() => resetButecoWebState());

    it("applies an envelope and notifies subscribers", () => {
        const cb = vi.fn();
        subscribeButecoWeb(cb);
        applyButecoWebEnvelope({
            state: {
                status: { loggedIn: true, user: { id: "u1", displayName: "Ana" } },
                lobby: [],
                room: null
            },
            event: { type: "status", status: { loggedIn: true, user: { id: "u1", displayName: "Ana" } } }
        });
        expect(getButecoWebState().status.loggedIn).toBe(true);
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it("ignores malformed envelopes", () => {
        const cb = vi.fn();
        subscribeButecoWeb(cb);
        applyButecoWebEnvelope(undefined as any);
        expect(cb).not.toHaveBeenCalled();
    });
});
