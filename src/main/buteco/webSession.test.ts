/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { cookieHeaderFrom, getWebStatusFrom, parseSessionUser } from "./webSession";

describe("cookieHeaderFrom", () => {
    it("extracts only the session cookie", () => {
        const header = cookieHeaderFrom([
            { name: "other", value: "x" },
            { name: "__Secure-better-auth.session_token", value: "tok" }
        ]);
        expect(header).toBe("__Secure-better-auth.session_token=tok");
    });

    it("returns null without the session cookie", () => {
        expect(cookieHeaderFrom([])).toBeNull();
        expect(cookieHeaderFrom([{ name: "a", value: "b" }])).toBeNull();
    });
});

describe("parseSessionUser", () => {
    it("maps the better-auth user", () => {
        expect(parseSessionUser({ user: { id: "u1", name: "Ana", image: "http://a" } })).toEqual({
            id: "u1",
            displayName: "Ana",
            avatar: "http://a"
        });
    });

    it("returns null on malformed bodies", () => {
        expect(parseSessionUser(null)).toBeNull();
        expect(parseSessionUser({})).toBeNull();
        expect(parseSessionUser({ user: {} })).toBeNull();
    });
});

describe("getWebStatusFrom", () => {
    it("is logged out without a cookie", async () => {
        const fetchImpl = vi.fn() as unknown as typeof fetch;
        expect(await getWebStatusFrom(null, fetchImpl)).toEqual({ loggedIn: false, user: null });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("returns the user when the session endpoint answers", async () => {
        const fetchImpl = vi.fn(
            async () => new Response(JSON.stringify({ user: { id: "u1", name: "Ana" } }), { status: 200 })
        ) as unknown as typeof fetch;
        const status = await getWebStatusFrom("cookie=1", fetchImpl);
        expect(status).toEqual({ loggedIn: true, user: { id: "u1", displayName: "Ana", avatar: null } });
        const [url, init] = (fetchImpl as any).mock.calls[0];
        expect(url).toBe("https://games.butecodosdevs.com/api/auth/get-session");
        expect((init.headers as any).cookie).toBe("cookie=1");
    });

    it("treats a 200 with a null body as logged out", async () => {
        const fetchImpl = vi.fn(async () => new Response("null", { status: 200 })) as unknown as typeof fetch;
        expect(await getWebStatusFrom("cookie=1", fetchImpl)).toEqual({ loggedIn: false, user: null });
    });

    it("treats an unparsable 200 body as logged out", async () => {
        const fetchImpl = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
        expect(await getWebStatusFrom("cookie=1", fetchImpl)).toEqual({ loggedIn: false, user: null });
    });

    it("stays logged in without a user when the endpoint fails", async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error("down");
        }) as unknown as typeof fetch;
        expect(await getWebStatusFrom("cookie=1", fetchImpl)).toEqual({ loggedIn: true, user: null });
    });
});
