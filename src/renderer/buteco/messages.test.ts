/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { BUTECO_ERROR_MESSAGES, isRepairErrorCode } from "./messages";

describe("BUTECO_ERROR_MESSAGES", () => {
    it("has a non-empty message for every code", () => {
        for (const [code, message] of Object.entries(BUTECO_ERROR_MESSAGES)) {
            expect(message, code).toBeTypeOf("string");
            expect(message.length, code).toBeGreaterThan(0);
        }
    });

    it("covers the repair codes with re-pairing guidance", () => {
        expect(BUTECO_ERROR_MESSAGES.token_invalid).toContain("pareamento");
        expect(BUTECO_ERROR_MESSAGES.client_outdated).toContain("Atualize");
    });
});

describe("isRepairErrorCode", () => {
    it("is true only for token_invalid and client_outdated", () => {
        expect(isRepairErrorCode("token_invalid")).toBe(true);
        expect(isRepairErrorCode("client_outdated")).toBe(true);
        expect(isRepairErrorCode("screen_taken")).toBe(false);
        expect(isRepairErrorCode("network")).toBe(false);
    });

    it("is false for an absent code", () => {
        expect(isRepairErrorCode(undefined)).toBe(false);
    });
});
