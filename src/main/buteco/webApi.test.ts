/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { fetchWebIce, webPublishScreen, webReleaseScreen, webRequest } from "./webApi";
import { getWebCookieHeader } from "./webSession";

vi.mock("./webSession", () => ({
    getWebCookieHeader: vi.fn()
}));

function fakeFetch(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("webRequest", () => {
    it("sends the cookie header and parses JSON", async () => {
        const fetchImpl = fakeFetch(200, { ok: 1 });
        const res = await webRequest<{ ok: number }>("/api/x", {
            method: "POST",
            body: { a: 1 },
            cookieHeader: "c=1",
            fetchImpl
        });
        expect(res).toEqual({ ok: true, value: { ok: 1 } });
        const [url, init] = (fetchImpl as any).mock.calls[0];
        expect(url).toBe("https://games.butecodosdevs.com/api/x");
        expect((init.headers as any).cookie).toBe("c=1");
        expect(init.body).toBe(JSON.stringify({ a: 1 }));
    });

    it("fails fast without a cookie", async () => {
        const fetchImpl = vi.fn() as unknown as typeof fetch;
        const res = await webRequest("/api/x", { method: "GET", cookieHeader: null, fetchImpl });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("token_invalid");
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("maps a 401 to token_invalid", async () => {
        const res = await webRequest("/api/x", { method: "GET", cookieHeader: "c=1", fetchImpl: fakeFetch(401, {}) });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("token_invalid");
    });

    it("maps a cookie-store rejection to network instead of throwing", async () => {
        vi.mocked(getWebCookieHeader).mockRejectedValueOnce(new Error("cookie store down"));
        const fetchImpl = vi.fn() as unknown as typeof fetch;
        const res = await webRequest("/api/x", { method: "GET", fetchImpl });
        expect(res).toEqual({ ok: false, error: { code: "network", message: "Falha de rede." } });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe("web endpoints", () => {
    it("fetches ICE servers", async () => {
        const fetchImpl = fakeFetch(200, { iceServers: [{ urls: "stun:x" }] });
        const res = await fetchWebIce({ cookieHeader: "c=1", fetchImpl });
        expect(res).toEqual({ ok: true, value: [{ urls: "stun:x" }] });
        expect((fetchImpl as any).mock.calls[0][0]).toBe(
            "https://games.butecodosdevs.com/api/rtc/ice?purpose=screenshare"
        );
    });

    it("publishes via WHIP with roomId/socketId/sdp", async () => {
        const fetchImpl = fakeFetch(200, { sdp: "v=0 answer" });
        const res = await webPublishScreen("r1", "s1", "v=0 offer", { cookieHeader: "c=1", fetchImpl });
        expect(res).toEqual({ ok: true, value: { sdp: "v=0 answer" } });
        const [url, init] = (fetchImpl as any).mock.calls[0];
        expect(url).toBe("https://games.butecodosdevs.com/api/compartilhagram/sfu/screen/whip");
        expect(JSON.parse(init.body)).toEqual({ roomId: "r1", socketId: "s1", sdp: "v=0 offer" });
    });

    it("releases the screen slot with on:false", async () => {
        const fetchImpl = fakeFetch(204, undefined);
        await webReleaseScreen("r1", "s1", { cookieHeader: "c=1", fetchImpl });
        const [url, init] = (fetchImpl as any).mock.calls[0];
        expect(url).toBe("https://games.butecodosdevs.com/api/compartilhagram/sfu/screen");
        expect(JSON.parse(init.body)).toEqual({ roomId: "r1", socketId: "s1", on: false });
    });
});
