/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { mapGroundRefusal } from "./buteco";

describe("mapGroundRefusal", () => {
    it("maps a known server code that differs from the status fallback", () => {
        expect(mapGroundRefusal(409, { error: "device_error" }).code).toBe("device_error");
    });

    it("prefers a known server code over any status fallback", () => {
        expect(mapGroundRefusal(500, { error: "screen_taken" }).code).toBe("screen_taken");
    });

    it("maps 401 to token_invalid", () => {
        expect(mapGroundRefusal(401, {}).code).toBe("token_invalid");
    });

    it("maps 426 to client_outdated", () => {
        expect(mapGroundRefusal(426, {}).code).toBe("client_outdated");
    });

    it("maps 409 with no server code to screen_taken", () => {
        expect(mapGroundRefusal(409, {}).code).toBe("screen_taken");
    });

    it("maps an unknown status to network", () => {
        expect(mapGroundRefusal(500, {}).code).toBe("network");
    });

    it("uses the server code as the message", () => {
        expect(mapGroundRefusal(500, { error: "screen_taken" }).message).toBe("screen_taken");
    });

    it("uses HTTP <status> as the message when there is no server code", () => {
        expect(mapGroundRefusal(503, {}).message).toBe("HTTP 503");
    });

    it("carries retry-after for busy", () => {
        const err = mapGroundRefusal(409, { error: "busy" }, "2");
        expect(err.code).toBe("busy");
        expect(err.retryAfterSec).toBe(2);
    });

    it("leaves retryAfterSec undefined for a non-numeric retry-after", () => {
        const err = mapGroundRefusal(409, { error: "busy" }, "abc");
        expect(err.code).toBe("busy");
        expect(err.retryAfterSec).toBeUndefined();
    });

    it("leaves retryAfterSec undefined for busy when no retry-after is given", () => {
        const err = mapGroundRefusal(409, { error: "busy" });
        expect(err.code).toBe("busy");
        expect(err.retryAfterSec).toBeUndefined();
    });
});
