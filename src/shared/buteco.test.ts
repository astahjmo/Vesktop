/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { mapGroundRefusal } from "./buteco";

describe("mapGroundRefusal", () => {
    it("maps known server codes", () => {
        expect(mapGroundRefusal(409, { error: "screen_taken" }).code).toBe("screen_taken");
    });

    it("maps 401 to token_invalid", () => {
        expect(mapGroundRefusal(401, {}).code).toBe("token_invalid");
    });

    it("maps 426 to client_outdated", () => {
        expect(mapGroundRefusal(426, {}).code).toBe("client_outdated");
    });

    it("carries retry-after for busy", () => {
        const err = mapGroundRefusal(409, { error: "busy" }, "2");
        expect(err.retryAfterSec).toBe(2);
    });
});
