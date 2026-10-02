/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { planSync, type PulledStream, pullLayer, type SyncInput } from "./sfuPlan";
import { encodingsFor, screenPreset } from "./sfuPresets";

function input(patch: Partial<SyncInput>): SyncInput {
    return {
        selfId: "me",
        members: [],
        pulled: [],
        skip: new Set(),
        wantCameras: true,
        wantScreensFrom: new Set(),
        ...patch
    };
}

const pulled = (userId: string, kind: "camera" | "screen", streamId: string, mid: string): PulledStream => ({
    userId,
    kind,
    streamId,
    mid,
    rid: "h"
});

describe("planSync", () => {
    it("pulls the cameras of other members and never your own stream", () => {
        const plan = planSync(
            input({
                members: [
                    { userId: "me", cameraId: "c0", screenId: "s0" },
                    { userId: "ana", cameraId: "c1" },
                    { userId: "bia" }
                ],
                wantScreensFrom: new Set(["me", "ana"])
            })
        );
        expect(plan.pull).toEqual([{ userId: "ana", kind: "camera" }]);
        expect(plan.close).toEqual([]);
    });

    it("only pulls cameras when asked to", () => {
        const plan = planSync(input({ wantCameras: false, members: [{ userId: "ana", cameraId: "c1" }] }));
        expect(plan.pull).toEqual([]);
    });

    it("pulls a screen only for wanted users and only when it goes through the Cloudflare SFU", () => {
        const members = [
            { userId: "ana", screenId: "s1", screenTransport: "cloudflare" },
            { userId: "bia", screenId: "s2", screenTransport: "mediamtx" },
            { userId: "caio", screenId: "s3" },
            { userId: "dani", screenId: "s4", screenTransport: "cloudflare" }
        ];
        const plan = planSync(input({ members, wantScreensFrom: new Set(["ana", "bia", "caio"]) }));
        expect(plan.pull).toEqual([
            { userId: "ana", kind: "screen" },
            { userId: "caio", kind: "screen" }
        ]);
    });

    it("keeps matching tracks, closes vanished ones and re-pulls when the stream id changes", () => {
        const plan = planSync(
            input({
                members: [
                    { userId: "ana", cameraId: "c1" },
                    { userId: "bia", cameraId: "c2-novo" }
                ],
                pulled: [
                    pulled("ana", "camera", "c1", "3"),
                    pulled("bia", "camera", "c2", "4"),
                    pulled("caio", "camera", "c9", "5")
                ]
            })
        );
        expect(plan.close.sort()).toEqual(["4", "5"]);
        expect(plan.pull).toEqual([{ userId: "bia", kind: "camera" }]);
    });

    it("skips streams that just failed, until the retry clears them", () => {
        const members = [{ userId: "ana", cameraId: "c1" }];
        expect(planSync(input({ members, skip: new Set(["ana:camera"]) })).pull).toEqual([]);
        expect(planSync(input({ members })).pull).toEqual([{ userId: "ana", kind: "camera" }]);
    });

    it("closes everything when nobody wants it anymore", () => {
        const plan = planSync(
            input({ wantCameras: false, pulled: [pulled("ana", "screen", "s1", "7")], members: [{ userId: "ana" }] })
        );
        expect(plan.close).toEqual(["7"]);
        expect(plan.pull).toEqual([]);
    });
});

describe("pullLayer", () => {
    it("asks for the high layer for the focused user or with few cameras", () => {
        expect(pullLayer({ remoteCameraCount: 9, focused: true })).toBe("h");
        expect(pullLayer({ remoteCameraCount: 4, focused: false })).toBe("h");
        expect(pullLayer({ remoteCameraCount: 5, focused: false })).toBe("l");
    });
});

describe("screenPreset", () => {
    it("matches the site's bitrate table", () => {
        const p720 = screenPreset(720, 30);
        expect(p720.capture).toEqual({ width: 1280, height: 720, frameRate: 30 });
        expect(p720.layers.map(l => [l.rid, l.maxBitrateKbps, l.maxFramerate])).toEqual([
            ["h", 2000, 30],
            ["l", 500, 24]
        ]);
        expect(screenPreset(1080, 60).layers[0].maxBitrateKbps).toBe(4500);
    });

    it("maps 1440p to the 1080p profile with more bitrate and unknown fps to 30", () => {
        const p1440 = screenPreset(1440, 30);
        expect(p1440.capture.height).toBe(1080);
        expect(p1440.layers[0].maxBitrateKbps).toBe(4500);
        expect(screenPreset(720, 45).capture.frameRate).toBe(30);
    });

    it("builds RTP encodings in bits per second", () => {
        expect(encodingsFor(screenPreset(720, 30))[0]).toEqual({
            rid: "h",
            scaleResolutionDownBy: 1,
            maxBitrate: 2_000_000,
            maxFramerate: 30
        });
    });
});
