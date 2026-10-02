/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { screenTransportOrder, viewTransportFor } from "./screenTransport";

describe("screenTransportOrder", () => {
    it("tries what the room asks for first and the other one as a fallback", () => {
        expect(screenTransportOrder("mediamtx")).toEqual(["mediamtx", "cloudflare"]);
        expect(screenTransportOrder("cloudflare")).toEqual(["cloudflare", "mediamtx"]);
    });

    it("defaults to Cloudflare, like the site", () => {
        expect(screenTransportOrder(undefined)).toEqual(["cloudflare", "mediamtx"]);
        expect(screenTransportOrder(null)).toEqual(["cloudflare", "mediamtx"]);
    });
});

describe("viewTransportFor", () => {
    it("follows what the streamer registered; only an explicit mediamtx uses WHEP", () => {
        expect(viewTransportFor("mediamtx")).toBe("mediamtx");
        expect(viewTransportFor("cloudflare")).toBe("cloudflare");
        expect(viewTransportFor(undefined)).toBe("cloudflare");
        expect(viewTransportFor(null)).toBe("cloudflare");
    });
});
