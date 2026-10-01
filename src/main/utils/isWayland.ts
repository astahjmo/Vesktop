/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * True on a Linux Wayland session. Screen capture there always goes through
 * the xdg-desktop-portal: `desktopCapturer.getSources` opens one ScreenCast
 * session and Chromium's PipeWire capturer opens its own when the stream
 * starts, so enumerating sources would only add an extra chooser dialog.
 */
export const isWayland =
    process.platform === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);
