/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { afterEach, describe, expect, it } from "vitest";

import { cacheSources, clearCachedSources, peekCachedSource, SOURCE_CACHE_TTL_MS } from "./sources";

function fakeSource(id: string) {
    return { id, name: id } as any;
}

describe("source cache", () => {
    afterEach(() => clearCachedSources());

    it("returns null when nothing was cached", () => {
        expect(peekCachedSource("screen:1")).toBeNull();
    });

    it("returns a cached source by id", () => {
        cacheSources([fakeSource("screen:1"), fakeSource("window:2")]);

        expect(peekCachedSource("window:2")?.id).toBe("window:2");
        expect(peekCachedSource("screen:9")).toBeNull();
    });

    it("expires and drops the cache after the TTL", () => {
        cacheSources([fakeSource("screen:1")]);

        expect(peekCachedSource("screen:1", Date.now() + SOURCE_CACHE_TTL_MS + 1)).toBeNull();
        expect(peekCachedSource("screen:1")).toBeNull();
    });

    it("a later listing replaces the previous one", () => {
        cacheSources([fakeSource("screen:1")]);
        cacheSources([fakeSource("screen:2")]);

        expect(peekCachedSource("screen:1")).toBeNull();
        expect(peekCachedSource("screen:2")?.id).toBe("screen:2");
    });
});
