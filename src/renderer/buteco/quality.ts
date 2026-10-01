/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoLimits } from "shared/buteco";

/** Resolutions the picker offers; `ButecoPublishMeta.height` only accepts these. */
export const BUTECO_HEIGHTS = [720, 1080, 1440] as const;
/** Frame rates the picker offers; `ButecoPublishMeta.fps` only accepts these. */
export const BUTECO_FPS = [30, 60] as const;

export type ButecoHeight = (typeof BUTECO_HEIGHTS)[number];
export type ButecoFps = (typeof BUTECO_FPS)[number];

const DEFAULT_HEIGHT: ButecoHeight = 1080;
const DEFAULT_FPS: ButecoFps = 30;

/** Largest allowed value at or below `value`; the smallest when `value` is below all. */
function floorTo<T extends number>(allowed: readonly T[], value: number): T {
    for (let i = allowed.length - 1; i >= 0; i--) {
        if (allowed[i] <= value) return allowed[i];
    }
    return allowed[0];
}

/**
 * Clamps a requested resolution to the room's `maxHeight` and the values the
 * strict publish schema accepts. Unknown or too-large requests floor to the
 * nearest allowed value; a too-small request floors to the minimum offered.
 */
export function clampHeight(value: number | undefined, maxHeight: number | undefined): ButecoHeight {
    const cap = Math.min(
        maxHeight ?? BUTECO_HEIGHTS[BUTECO_HEIGHTS.length - 1],
        BUTECO_HEIGHTS[BUTECO_HEIGHTS.length - 1]
    );
    const allowed = BUTECO_HEIGHTS.filter(h => h <= cap);
    const candidates: readonly ButecoHeight[] = allowed.length ? allowed : [BUTECO_HEIGHTS[0]];
    return floorTo(candidates, value ?? DEFAULT_HEIGHT);
}

/** Clamps a requested frame rate to the room's `maxFps`. Mirrors `clampHeight`. */
export function clampFps(value: number | undefined, maxFps: number | undefined): ButecoFps {
    const cap = Math.min(maxFps ?? BUTECO_FPS[BUTECO_FPS.length - 1], BUTECO_FPS[BUTECO_FPS.length - 1]);
    const allowed = BUTECO_FPS.filter(f => f <= cap);
    const candidates: readonly ButecoFps[] = allowed.length ? allowed : [BUTECO_FPS[0]];
    return floorTo(candidates, value ?? DEFAULT_FPS);
}

/**
 * Applies both clamps at once, so a `ButecoPick` can be normalised against the
 * session limits before its values are copied into the strict publish `meta`.
 */
export function clampQuality(
    value: { height?: number; fps?: number },
    limits: Pick<ButecoLimits, "maxHeight" | "maxFps"> | null | undefined
): { height: ButecoHeight; fps: ButecoFps } {
    return {
        height: clampHeight(value.height, limits?.maxHeight),
        fps: clampFps(value.fps, limits?.maxFps)
    };
}
