/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const CAPTURE_TTL_MS = 10_000;

let armed: { sourceId: string; armedAt: number } | null = null;

export function armCapture(sourceId: string) {
    armed = { sourceId, armedAt: Date.now() };
}

export function cancelCapture() {
    armed = null;
}

export function peekCapture(): string | null {
    return armed?.sourceId ?? null;
}

/** Single-use: returns the armed source id and clears it. */
export function consumeCapture(now = Date.now()): string | null {
    if (!armed) return null;
    if (now - armed.armedAt > CAPTURE_TTL_MS) {
        armed = null;
        return null;
    }
    const id = armed.sourceId;
    armed = null;
    return id;
}
