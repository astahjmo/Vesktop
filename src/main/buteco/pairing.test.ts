/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { clientInfo, createTokenVault, exchangeCode, normalizePairingCode } from "./pairing";

describe("normalizePairingCode", () => {
    it("uppercases and strips spaces/dashes", () => {
        expect(normalizePairingCode(" ab-12 3c ")).toBe("AB123C");
    });
    it("rejects empty and invalid chars", () => {
        expect(normalizePairingCode("   ")).toBeNull();
        expect(normalizePairingCode("ab$c")).toBeNull();
    });
});

describe("clientInfo", () => {
    it("describes the buteco-share helper client", () => {
        expect(clientInfo("1.2.3")).toEqual({
            app: "buteco-share",
            version: "1.2.3",
            os: process.platform,
            osVersion: process.getSystemVersion?.() ?? "",
            protocol: 1,
            capabilities: { appAudio: false, mic: true, maxHeight: 1440, maxFps: 60 }
        });
    });
});

describe("exchangeCode", () => {
    it("rejects an invalid code without hitting the network", async () => {
        const fetchImpl = vi.fn() as unknown as typeof fetch;
        const res = await exchangeCode("ab$c", fetchImpl);
        expect(res).toEqual({
            ok: false,
            error: { code: "invalid_code_format", message: "Código de pareamento inválido." }
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("normalizes the code and posts { code, client } to the exchange endpoint", async () => {
        const fetchImpl = vi.fn(
            async () => new Response(JSON.stringify({ token: "tok" }), { status: 200 })
        ) as unknown as typeof fetch;
        const client = clientInfo("1.2.3");

        const res = await exchangeCode(" ab-12 3c ", fetchImpl, client);

        expect(res).toEqual({ ok: true, value: { token: "tok" } });
        const [url, init] = (fetchImpl as any).mock.calls[0];
        expect(url).toBe("https://games.butecodosdevs.com/api/compartilhagram/pairing/exchange");
        expect(init.method).toBe("POST");
        expect(init.headers.authorization).toBeUndefined();
        expect(JSON.parse(init.body)).toEqual({ code: "AB123C", client });
    });

    it("propagates a Ground refusal", async () => {
        const fetchImpl = vi.fn(
            async () => new Response(JSON.stringify({ error: "client_outdated" }), { status: 426 })
        ) as unknown as typeof fetch;

        const res = await exchangeCode("ABC", fetchImpl);

        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("client_outdated");
    });
});

describe("tokenVault", () => {
    let vault: ReturnType<typeof createTokenVault>;
    beforeEach(() => {
        vault = createTokenVault();
    });

    it("returns null before set", () => {
        expect(vault.getToken()).toBeNull();
    });

    it("returns token before expiry and null after", () => {
        vault.set({ token: "abc", tokenExpiresAt: "2100-01-01T00:00:00.000Z" } as any);
        expect(vault.getToken()).toBe("abc");
        expect(vault.getToken(Date.parse("2200-01-01T00:00:00.000Z"))).toBeNull();
    });

    it("clears", () => {
        vault.set({ token: "abc", tokenExpiresAt: "2100-01-01T00:00:00.000Z" } as any);
        vault.clear();
        expect(vault.getToken()).toBeNull();
    });
});
