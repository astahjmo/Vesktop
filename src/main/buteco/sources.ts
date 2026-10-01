/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DesktopCapturerSource } from "electron";

/**
 * On Wayland `desktopCapturer.getSources` opens an xdg-desktop-portal ScreenCast
 * session. A second call while that session is still alive fails with "Failed
 * to get sources" (`ScreenCastPortal failed: 3`), which is exactly what the
 * armed-capture handler did after the panel had listed the sources. Keep the
 * last listing so the handler can reuse the portal session instead of opening
 * another one.
 */
export const SOURCE_CACHE_TTL_MS = 5 * 60_000;

/**
 * Synthetic source handed to `setDisplayMediaRequestHandler` on Wayland.
 * Chromium's PipeWire capturer ignores it and opens its own portal session, so
 * the system picker shows exactly once — at capture time. Passing a real source
 * would add a second chooser (electron/electron#30652).
 */
export const WAYLAND_PLACEHOLDER_ID = "screen:0:0";

/** Source tile shown by the Buteco panel on Wayland, where the portal picks. */
export const WAYLAND_SOURCE_LABEL = "Tela ou janela (escolha no sistema)";

let cached: { sources: DesktopCapturerSource[]; at: number } | null = null;

export function cacheSources(sources: DesktopCapturerSource[], now = Date.now()): void {
    cached = { sources, at: now };
}

export function peekCachedSource(id: string, now = Date.now()): DesktopCapturerSource | null {
    if (!cached) return null;

    if (now - cached.at > SOURCE_CACHE_TTL_MS) {
        cached = null;
        return null;
    }

    return cached.sources.find(source => source.id === id) ?? null;
}

export function clearCachedSources(): void {
    cached = null;
}
