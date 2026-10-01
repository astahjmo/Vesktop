/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { clampFps, clampHeight, clampQuality } from "./quality";

describe("clampHeight", () => {
    it("keeps an allowed value at or below the limit", () => {
        expect(clampHeight(1080, 1440)).toBe(1080);
        expect(clampHeight(720, 1440)).toBe(720);
        expect(clampHeight(1440, 1440)).toBe(1440);
    });

    it("floors to the limit when the request exceeds maxHeight", () => {
        expect(clampHeight(1440, 1080)).toBe(1080);
        expect(clampHeight(1440, 720)).toBe(720);
        expect(clampHeight(1080, 720)).toBe(720);
    });

    it("floors an arbitrary request to the nearest allowed value", () => {
        expect(clampHeight(900, 1440)).toBe(720);
        expect(clampHeight(1439, 1440)).toBe(1080);
        expect(clampHeight(0, 1440)).toBe(720);
    });

    it("defaults to 1080 when unset, clamped to the limit", () => {
        expect(clampHeight(undefined, 1440)).toBe(1080);
        expect(clampHeight(undefined, 1080)).toBe(1080);
        expect(clampHeight(undefined, 720)).toBe(720);
    });

    it("defaults to the full range when limits are unknown", () => {
        expect(clampHeight(undefined, undefined)).toBe(1080);
        expect(clampHeight(1440, undefined)).toBe(1440);
    });
});

describe("clampFps", () => {
    it("keeps an allowed value at or below the limit", () => {
        expect(clampFps(30, 60)).toBe(30);
        expect(clampFps(60, 60)).toBe(60);
    });

    it("floors to 30 when maxFps is 30", () => {
        expect(clampFps(60, 30)).toBe(30);
        expect(clampFps(45, 30)).toBe(30);
    });

    it("defaults to 30 when unset", () => {
        expect(clampFps(undefined, 60)).toBe(30);
        expect(clampFps(undefined, undefined)).toBe(30);
    });
});

describe("clampQuality", () => {
    it("clamps both fields against the session limits", () => {
        expect(clampQuality({ height: 1440, fps: 60 }, { maxHeight: 720, maxFps: 30 })).toEqual({
            height: 720,
            fps: 30
        });
    });

    it("uses defaults when the limits are missing", () => {
        expect(clampQuality({}, null)).toEqual({ height: 1080, fps: 30 });
    });
});
