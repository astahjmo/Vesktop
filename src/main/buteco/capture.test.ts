/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { armCapture, cancelCapture, CAPTURE_TTL_MS, consumeCapture, peekCapture } from "./capture";

describe("armed capture", () => {
    beforeEach(() => cancelCapture());

    it("returns null when nothing armed", () => {
        expect(consumeCapture()).toBeNull();
    });

    it("consumes once", () => {
        armCapture("screen:1");
        expect(peekCapture()).toBe("screen:1");
        expect(consumeCapture()).toBe("screen:1");
        expect(consumeCapture()).toBeNull();
    });

    it("expires after TTL", () => {
        armCapture("screen:1");
        expect(consumeCapture(Date.now() + CAPTURE_TTL_MS + 1)).toBeNull();
    });

    it("expired consume clears the armed id too", () => {
        armCapture("screen:1");
        expect(consumeCapture(Date.now() + CAPTURE_TTL_MS + 1)).toBeNull();
        expect(peekCapture()).toBeNull();
        expect(consumeCapture()).toBeNull();
    });

    it("cancel clears", () => {
        armCapture("screen:1");
        cancelCapture();
        expect(consumeCapture()).toBeNull();
    });

    it("pins the TTL contract consumed by the picker", () => {
        expect(CAPTURE_TTL_MS).toBe(10_000);
    });

    it("stays valid at the TTL boundary and expires strictly after", () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000_000);
            armCapture("boundary");
            expect(consumeCapture(1_000_000 + CAPTURE_TTL_MS)).toBe("boundary");

            vi.setSystemTime(2_000_000);
            armCapture("late");
            expect(consumeCapture(2_000_000 + CAPTURE_TTL_MS + 1)).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
