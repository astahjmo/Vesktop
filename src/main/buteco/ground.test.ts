/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { groundRequest } from "./ground";

function fakeFetch(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("groundRequest", () => {
    it("attaches bearer token and parses JSON", async () => {
        const fetchImpl = fakeFetch(200, { hello: "world" });
        const res = await groundRequest<{ hello: string }>("/api/x", {
            method: "POST",
            body: { a: 1 },
            token: "tok",
            fetchImpl
        });
        expect(res).toEqual({ ok: true, value: { hello: "world" } });
        const [url, init] = (fetchImpl as any).mock.calls[0];
        expect(url).toBe("https://games.butecodosdevs.com/api/x");
        expect((init.headers as any).authorization).toBe("Bearer tok");
    });

    it("returns network error on fetch throw", async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error("boom");
        }) as unknown as typeof fetch;
        const res = await groundRequest("/api/x", { method: "GET", fetchImpl });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("network");
    });

    it("maps a 401 refusal", async () => {
        const fetchImpl = fakeFetch(401, {});
        const res = await groundRequest("/api/x", { method: "GET", fetchImpl });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("token_invalid");
    });
});
