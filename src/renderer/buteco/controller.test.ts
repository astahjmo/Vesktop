/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { createButecoController } from "./controller";

function fakeStream(id: string) {
    const track = {
        id,
        kind: id.startsWith("aud") ? "audio" : "video",
        contentHint: "",
        stop: vi.fn(),
        addEventListener: vi.fn()
    };
    return { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [track] } as any;
}

function fakePC() {
    const pc: any = {
        addedTransceivers: [] as any[],
        localDescription: { sdp: "v=0 offer" },
        addTransceiver: vi.fn((track: any, init: any) => {
            const sender = { setCodecPreferences: vi.fn() };
            pc.addedTransceivers.push({ init });
            return { sender };
        }),
        createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0 offer" })),
        setLocalDescription: vi.fn(async () => {}),
        setRemoteDescription: vi.fn(async () => {}),
        close: vi.fn()
    };
    return pc;
}

const session = {
    token: "t",
    room: { id: "r", slug: "r", name: "r" },
    iceServers: [],
    limits: { screenAudioAllowed: true, maxHeight: 1080, maxFps: 30, maxVideoKbps: 1, audioKbps: 1 },
    socket: { url: "wss://g", path: "/socket.io", namespace: "/helper" }
} as any;

describe("ButecoController", () => {
    it("publishes a video-only sendonly transceiver and applies the answer", async () => {
        const pc = fakePC();
        const publish = vi.fn(async () => ({ ok: true as const, value: { sdp: "v=0 answer", streamId: "s1" } }));
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => fakeStream("vid1"),
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish,
            unpublish: async () => ({ ok: true as const, value: undefined })
        });

        const res = await c.start({
            sourceId: "",
            videoKind: "screen",
            videoLabel: "M",
            height: 1080,
            fps: 30,
            mic: false
        });
        expect(res.ok).toBe(true);
        expect(pc.addedTransceivers[0].init.direction).toBe("sendonly");
        expect(publish).toHaveBeenCalledWith(
            "v=0 offer",
            expect.objectContaining({ height: 1080, fps: 30, mic: false })
        );
        expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "v=0 answer" });
        expect(pc.addedTransceivers).toHaveLength(1);
    });

    it("adds an audio transceiver when mic is on and limits allow", async () => {
        const pc = fakePC();
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => fakeStream("vid1"),
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish: async () => ({ ok: true as const, value: { sdp: "v=0 answer", streamId: "s1" } }),
            unpublish: async () => ({ ok: true as const, value: undefined })
        });
        await c.start({ sourceId: "", videoKind: "screen", videoLabel: "M", height: 1080, fps: 30, mic: true });
        expect(pc.addedTransceivers).toHaveLength(2);
    });

    it("stops tracks and unpublishes", async () => {
        const pc = fakePC();
        const unpublish = vi.fn(async () => ({ ok: true as const, value: undefined }));
        const stream = fakeStream("vid1");
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => stream,
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish: async () => ({ ok: true as const, value: { sdp: "v=0 answer", streamId: "s1" } }),
            unpublish
        });
        await c.start({ sourceId: "", videoKind: "screen", videoLabel: "M", height: 1080, fps: 30, mic: false });
        await c.stop();
        expect(stream.getTracks()[0].stop).toHaveBeenCalled();
        expect(pc.close).toHaveBeenCalled();
        expect(unpublish).toHaveBeenCalled();
    });
});
