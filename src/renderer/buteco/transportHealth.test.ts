/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
    FAILURE_MEMORY_MS,
    orderByHealth,
    recordTransportFailure,
    recordTransportSuccess,
    resetTransportHealth
} from "./transportHealth";

describe("orderByHealth", () => {
    beforeEach(() => resetTransportHealth());

    it("keeps the requested order when nothing failed", () => {
        expect(orderByHealth(["mediamtx", "cloudflare"])).toEqual(["mediamtx", "cloudflare"]);
    });

    it("moves a transport that failed recently to the end", () => {
        recordTransportFailure("mediamtx", 1000);
        expect(orderByHealth(["mediamtx", "cloudflare"], 2000)).toEqual(["cloudflare", "mediamtx"]);
        expect(orderByHealth(["cloudflare", "mediamtx"], 2000)).toEqual(["cloudflare", "mediamtx"]);
    });

    it("forgets the failure after a while", () => {
        recordTransportFailure("mediamtx", 1000);
        expect(orderByHealth(["mediamtx", "cloudflare"], 1000 + FAILURE_MEMORY_MS + 1)).toEqual([
            "mediamtx",
            "cloudflare"
        ]);
    });

    it("forgets the failure as soon as that transport works again", () => {
        recordTransportFailure("mediamtx", 1000);
        recordTransportSuccess("mediamtx");
        expect(orderByHealth(["mediamtx", "cloudflare"], 2000)).toEqual(["mediamtx", "cloudflare"]);
    });

    it("keeps the original order when both failed recently", () => {
        recordTransportFailure("mediamtx", 1000);
        recordTransportFailure("cloudflare", 1500);
        expect(orderByHealth(["mediamtx", "cloudflare"], 2000)).toEqual(["mediamtx", "cloudflare"]);
    });
});
