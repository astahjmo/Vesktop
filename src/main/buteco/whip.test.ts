/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { publishScreen } from "./whip";

const meta = {
    videoKind: "screen",
    videoLabel: "Monitor 1",
    audioLabel: null,
    mic: false,
    height: 1080,
    fps: 30
} as const;

function fetchReturns(...responses: Array<{ status: number; body: any }>) {
    let i = 0;
    return vi.fn(async () => {
        const r = responses[Math.min(i++, responses.length - 1)];
        return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
}

describe("publishScreen", () => {
    it("returns answer sdp and streamId", async () => {
        const fetchImpl = fetchReturns({ status: 200, body: { sdp: "v=0 answer", streamId: "s1" } });
        const res = await publishScreen({ token: "t", offerSdp: "v=0 offer", meta, fetchImpl });
        expect(res).toEqual({ ok: true, value: { sdp: "v=0 answer", streamId: "s1" } });
    });

    it("retries busy then succeeds", async () => {
        const fetchImpl = fetchReturns(
            { status: 409, body: { error: "busy" } },
            { status: 200, body: { sdp: "v=0 answer", streamId: "s1" } }
        );
        const sleep = vi.fn(async () => {});
        const res = await publishScreen({ token: "t", offerSdp: "v=0 offer", meta, fetchImpl, sleep });
        expect(res.ok).toBe(true);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    it("gives up after retries with sfu_unavailable", async () => {
        const fetchImpl = fetchReturns({ status: 409, body: { error: "busy" } });
        const sleep = vi.fn(async () => {});
        const res = await publishScreen({ token: "t", offerSdp: "v=0 offer", meta, fetchImpl, sleep });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("sfu_unavailable");
    });

    it("rejects a malformed 200 response", async () => {
        const fetchImpl = fetchReturns({ status: 200, body: { nope: 1 } });
        const res = await publishScreen({ token: "t", offerSdp: "v=0 offer", meta, fetchImpl });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("sfu_unavailable");
    });
});
