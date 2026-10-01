/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { desktopCapturer, session, Streams } from "electron";
import { release } from "os";
import type { StreamPick } from "renderer/components/ScreenSharePicker";
import { IpcCommands, IpcEvents } from "shared/IpcEvents";

import { consumeCapture } from "./buteco/capture";
import { peekCachedSource, WAYLAND_PLACEHOLDER_ID } from "./buteco/sources";
import { sendRendererCommand } from "./ipcCommands";
import { handle } from "./utils/ipcWrappers";
import { isWayland } from "./utils/isWayland";

const supportsLoopbackWithoutChrome = process.platform === "win32" && Number(release().split(".").pop()) >= 19045;

/**
 * Placeholder handed to the display-media callback on Wayland. Chromium's
 * PipeWire capturer ignores the source and opens its own portal session, so
 * using a synthetic source keeps the system picker to a single dialog
 * (electron/electron#30652); a real `DesktopCapturerSource` would trigger a
 * second chooser.
 */
const waylandPlaceholder = { id: WAYLAND_PLACEHOLDER_ID, name: "Entire Screen" } as Electron.DesktopCapturerSource;

/**
 * Denies a pending display-media request. Electron throws "Video was requested,
 * but no video stream was provided" when the callback carries no video for a
 * video request; that throw rejects the async handler and surfaces as an
 * unhandled rejection. The request is already denied by an empty callback, so
 * swallow the throw.
 */
function denyDisplayMedia(callback: (streams: Streams) => void): void {
    try {
        callback({});
    } catch {
        // See above: denying a video request without a stream is not fatal.
    }
}

export function registerScreenShareHandler() {
    handle(IpcEvents.CAPTURER_GET_LARGE_THUMBNAIL, async (_, id: string) => {
        const sources = await desktopCapturer.getSources({
            types: ["window", "screen"],
            thumbnailSize: {
                width: 1920,
                height: 1080
            }
        });
        return sources.find(s => s.id === id)?.thumbnail.toDataURL();
    });

    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
        // Buteco: the module's own getDisplayMedia call consumes the armed source; never reopen the picker.
        const armedId = consumeCapture();
        if (armedId) {
            // Chromium opens its own portal session on Wayland; a placeholder
            // avoids a second chooser dialog (see `waylandPlaceholder`).
            if (isWayland) {
                callback({ video: waylandPlaceholder });
                return;
            }

            // Reuse the source from the panel's listing, which owns the live
            // portal session. Calling getSources again would re-enumerate.
            const cached = peekCachedSource(armedId);
            if (cached) {
                callback({ video: cached });
                return;
            }

            const sources = await desktopCapturer.getSources({ types: ["window", "screen"] }).catch(() => []);
            const source = sources.find(s => s.id === armedId);
            if (source) callback({ video: source });
            else denyDisplayMedia(callback);
            return;
        }

        // request full resolution on wayland right away because we always only end up with one result anyway
        const width = isWayland ? 1920 : 176;
        const sources = await desktopCapturer
            .getSources({
                types: ["window", "screen"],
                thumbnailSize: {
                    width,
                    height: width * (9 / 16)
                }
            })
            .catch(err => console.error("Error during screenshare picker", err));

        if (!sources) return denyDisplayMedia(callback);

        const data = sources.map(({ id, name, thumbnail }) => ({
            id,
            name,
            url: thumbnail.toDataURL()
        }));

        if (isWayland) {
            const video = data[0];
            if (video) {
                const stream = await sendRendererCommand<StreamPick>(IpcCommands.SCREEN_SHARE_PICKER, {
                    screens: [video],
                    skipPicker: true
                }).catch(() => null);

                if (stream === null) return denyDisplayMedia(callback);

                if (stream.mode === "buteco") {
                    // Handled by the Buteco module; do not send media to Discord's SFU.
                    return denyDisplayMedia(callback);
                }
            }

            if (video) callback({ video: waylandPlaceholder });
            else denyDisplayMedia(callback);
            return;
        }

        const choice = await sendRendererCommand<StreamPick>(IpcCommands.SCREEN_SHARE_PICKER, {
            screens: data,
            skipPicker: false
        }).catch(e => {
            console.error("Error during screenshare picker", e);
            return null;
        });

        if (!choice) return denyDisplayMedia(callback);

        if (choice.mode === "buteco") {
            // Handled by the Buteco module; do not send media to Discord's SFU.
            denyDisplayMedia(callback);
            return;
        }

        const source = sources.find(s => s.id === choice.id);
        if (!source) return denyDisplayMedia(callback);

        const streams: Streams = {
            video: source
        };
        if (choice.audio && process.platform === "win32") {
            // @ts-expect-error loopbackWithoutChrome is real but not documented
            streams.audio = supportsLoopbackWithoutChrome ? "loopbackWithoutChrome" : "loopback";
        }

        callback(streams);
    });
}
