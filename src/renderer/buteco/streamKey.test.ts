/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { discordStreamKey } from "./streamKey";

describe("discordStreamKey", () => {
    it("uses the guild format in servers and the call format in DMs", () => {
        expect(discordStreamKey("g1", "c1", "u1")).toBe("guild:g1:c1:u1");
        expect(discordStreamKey(null, "c1", "u1")).toBe("call:c1:u1");
        expect(discordStreamKey(undefined, "c1", "u1")).toBe("call:c1:u1");
    });
});
