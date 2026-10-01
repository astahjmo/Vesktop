/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { createButecoController } from "./controller";

function fakeTrack(kind: "video" | "audio", id: string) {
    return { id, kind, contentHint: "", stop: vi.fn(), addEventListener: vi.fn() };
}

function fakeStream(id: string) {
    const kind: "video" | "audio" = id.startsWith("aud") ? "audio" : "video";
    const track = fakeTrack(kind, id);
    return {
        tracks: [track],
        getTracks: () => [track],
        getVideoTracks: () => (kind === "video" ? [track] : []),
        getAudioTracks: () => (kind === "audio" ? [track] : [])
    } as any;
}

/** A stream with no tracks at all, to exercise the "no video track" failure path. */
function emptyStream() {
    return { tracks: [], getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] } as any;
}

function fakePC() {
    const pc: any = {
        addedTransceivers: [] as any[],
        localDescription: { sdp: "v=0 offer" },
        addTransceiver: vi.fn((track: any, init: any) => {
            const sender = { setCodecPreferences: vi.fn() };
            pc.addedTransceivers.push({ track, init });
            return { sender };
        }),
        createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0 offer" })),
        setLocalDescription: vi.fn(async () => {}),
        setRemoteDescription: vi.fn(async () => {}),
        close: vi.fn()
    };
    return pc;
}

function fakePublish(sdp = "v=0 answer") {
    return vi.fn(async (_sdp: string, _meta: any) => ({ ok: true as const, value: { sdp, streamId: "s1" } }));
}

const session = {
    token: "t",
    room: { id: "r", slug: "r", name: "r" },
    iceServers: [],
    limits: { screenAudioAllowed: true, maxHeight: 1080, maxFps: 30, maxVideoKbps: 1, audioKbps: 1 },
    socket: { url: "wss://g", path: "/socket.io", namespace: "/helper" }
} as any;

const noAudioSession = {
    ...session,
    limits: { ...session.limits, screenAudioAllowed: false }
} as any;

const baseOpts = {
    sourceId: "",
    videoKind: "screen" as const,
    videoLabel: "M",
    height: 1080 as const,
    fps: 30 as const
};

describe("ButecoController", () => {
    it("publishes a video-only sendonly transceiver and applies the answer", async () => {
        const pc = fakePC();
        const publish = fakePublish();
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => fakeStream("vid1"),
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish,
            unpublish: async () => ({ ok: true as const, value: undefined })
        });

        const res = await c.start({ ...baseOpts, mic: false });
        expect(res.ok).toBe(true);
        expect(pc.addedTransceivers[0].init.direction).toBe("sendonly");
        expect(publish).toHaveBeenCalledWith(
            "v=0 offer",
            expect.objectContaining({ height: 1080, fps: 30, mic: false })
        );
        expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "v=0 answer" });
        expect(pc.addedTransceivers).toHaveLength(1);
    });

    it("attaches the display stream to the video transceiver", async () => {
        const pc = fakePC();
        const display = fakeStream("vid1");
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => display,
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish: fakePublish(),
            unpublish: async () => ({ ok: true as const, value: undefined })
        });

        await c.start({ ...baseOpts, mic: false });
        expect(pc.addedTransceivers[0].init.streams).toEqual([display]);
        expect(pc.addedTransceivers[0].track).toBe(display.tracks[0]);
        expect(pc.addedTransceivers[0].track.kind).toBe("video");
    });

    it("adds an audio transceiver when mic is on and limits allow", async () => {
        const pc = fakePC();
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => fakeStream("vid1"),
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish: fakePublish(),
            unpublish: async () => ({ ok: true as const, value: undefined })
        });
        await c.start({ ...baseOpts, mic: true });
        expect(pc.addedTransceivers).toHaveLength(2);
        expect(pc.addedTransceivers[1].track.kind).toBe("audio");
    });

    it("does not add audio and reports mic:false when screen audio is disallowed", async () => {
        const pc = fakePC();
        const publish = fakePublish();
        const c = createButecoController({
            getSession: () => noAudioSession,
            getDisplayMedia: async () => fakeStream("vid1"),
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish,
            unpublish: async () => ({ ok: true as const, value: undefined })
        });
        await c.start({ ...baseOpts, mic: true });
        expect(pc.addedTransceivers).toHaveLength(1);
        expect(publish).toHaveBeenCalledWith("v=0 offer", expect.objectContaining({ mic: false, audioLabel: null }));
    });

    it("reports mic:false when getUserMedia yields no audio track", async () => {
        const pc = fakePC();
        const publish = fakePublish();
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => fakeStream("vid1"),
            getUserMedia: async () => emptyStream(),
            createPeerConnection: () => pc,
            publish,
            unpublish: async () => ({ ok: true as const, value: undefined })
        });
        await c.start({ ...baseOpts, mic: true });
        expect(pc.addedTransceivers).toHaveLength(1);
        expect(publish).toHaveBeenCalledWith("v=0 offer", expect.objectContaining({ mic: false }));
    });

    it("cleans up when publish refuses", async () => {
        const pc = fakePC();
        const unpublish = vi.fn(async () => ({ ok: true as const, value: undefined }));
        const display = fakeStream("vid1");
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => display,
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish: vi.fn(async () => ({ ok: false as const, error: { code: "busy" as const, message: "busy" } })),
            unpublish
        });
        const res = await c.start({ ...baseOpts, mic: false });
        expect(res.ok).toBe(false);
        expect(display.tracks[0].stop).toHaveBeenCalled();
        expect(pc.close).toHaveBeenCalled();
        expect(unpublish).toHaveBeenCalled();
        expect(c.getConnection()).toBeNull();
    });

    it("cleans up and fails when display media has no video track", async () => {
        const pc = fakePC();
        const unpublish = vi.fn(async () => ({ ok: true as const, value: undefined }));
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => emptyStream(),
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish: fakePublish(),
            unpublish
        });
        const res = await c.start({ ...baseOpts, mic: false });
        expect(res.ok).toBe(false);
        expect(pc.addTransceiver).not.toHaveBeenCalled();
        expect(unpublish).toHaveBeenCalled();
        expect(c.getConnection()).toBeNull();
    });

    it("starts virtmic and labels the app audio stream", async () => {
        const pc = fakePC();
        const publish = fakePublish();
        const nodes = [{ id: "node-1" }];
        const virtmic = { start: vi.fn(async (_nodes: unknown[]) => {}), stop: vi.fn(async () => {}) };
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => fakeStream("vid1"),
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish,
            unpublish: async () => ({ ok: true as const, value: undefined }),
            virtmic
        });
        await c.start({ ...baseOpts, mic: false, includeAudioNodes: nodes });

        expect(virtmic.start).toHaveBeenCalledWith(nodes);
        expect(pc.addedTransceivers).toHaveLength(2);
        expect(publish).toHaveBeenCalledWith(
            "v=0 offer",
            expect.objectContaining({ audioLabel: "vencord-screen-share" })
        );
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
            publish: fakePublish(),
            unpublish
        });
        await c.start({ ...baseOpts, mic: false });
        await c.stop();
        expect(stream.getTracks()[0].stop).toHaveBeenCalled();
        expect(pc.close).toHaveBeenCalled();
        expect(unpublish).toHaveBeenCalled();
    });
});
