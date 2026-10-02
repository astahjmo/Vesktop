/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { createButecoController, reorderVideoCodecs } from "./controller";

function fakeTrack(kind: "video" | "audio", id: string) {
    const listeners = new Map<string, Function>();
    return {
        id,
        kind,
        contentHint: "",
        stop: vi.fn(),
        addEventListener: vi.fn((ev: string, cb: Function) => {
            listeners.set(ev, cb);
        }),
        /** Test helper: dispatch a captured event (e.g. "ended"). */
        fire: (ev: string) => listeners.get(ev)?.()
    };
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
            pc.addedTransceivers.push({ track, init, sender });
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

    it("unmutes the virtmic after starting app audio", async () => {
        const pc = fakePC();
        const virtmic = {
            start: vi.fn(async (_nodes: unknown[]) => {}),
            stop: vi.fn(async () => {}),
            unmute: vi.fn(async () => {})
        };
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => fakeStream("vid1"),
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish: fakePublish(),
            unpublish: async () => ({ ok: true as const, value: undefined }),
            virtmic
        });

        await c.start({ ...baseOpts, mic: false, includeAudioNodes: [{ id: "node-1" }] });

        expect(virtmic.start).toHaveBeenCalledTimes(1);
        expect(virtmic.unmute).toHaveBeenCalledTimes(1);
        // Unmute must land after the link is created, or it is a no-op.
        expect(virtmic.unmute.mock.invocationCallOrder[0]).toBeGreaterThan(virtmic.start.mock.invocationCallOrder[0]);
    });

    it("does not touch the virtmic when app audio is not enabled", async () => {
        const pc = fakePC();
        const virtmic = {
            start: vi.fn(async (_nodes: unknown[]) => {}),
            stop: vi.fn(async () => {}),
            unmute: vi.fn(async () => {})
        };
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => fakeStream("vid1"),
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish: fakePublish(),
            unpublish: async () => ({ ok: true as const, value: undefined }),
            virtmic
        });

        await c.start({ ...baseOpts, mic: true, includeAudioNodes: [] });

        expect(virtmic.start).not.toHaveBeenCalled();
        expect(virtmic.unmute).not.toHaveBeenCalled();
    });

    it("tears down and unpublishes when the video track ends", async () => {
        const pc = fakePC();
        const unpublish = vi.fn(async () => ({ ok: true as const, value: undefined }));
        const display = fakeStream("vid1");
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => display,
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish: fakePublish(),
            unpublish
        });

        await c.start({ ...baseOpts, mic: false });
        expect(unpublish).not.toHaveBeenCalled();

        // Simulate the OS/Chromium "Stop sharing" gesture.
        display.tracks[0].fire("ended");
        await vi.waitFor(() => expect(unpublish).toHaveBeenCalledTimes(1));

        expect(display.tracks[0].stop).toHaveBeenCalled();
        expect(pc.close).toHaveBeenCalled();
        expect(c.getConnection()).toBeNull();
    });

    it("offers the full codec list (recovery codecs included) to setCodecPreferences", async () => {
        const codecs = [
            { mimeType: "video/VP9" },
            { mimeType: "video/rtx", sdpFmtpLine: "apt=96" },
            { mimeType: "video/VP8" },
            { mimeType: "video/H264" }
        ];
        const original = (globalThis as any).RTCRtpSender;
        (globalThis as any).RTCRtpSender = { getCapabilities: () => ({ codecs }) };

        try {
            const pc = fakePC();
            const c = createButecoController({
                getSession: () => session,
                getDisplayMedia: async () => fakeStream("vid1"),
                getUserMedia: async () => fakeStream("aud1"),
                createPeerConnection: () => pc,
                publish: fakePublish(),
                unpublish: async () => ({ ok: true as const, value: undefined })
            });

            await c.start({ ...baseOpts, mic: false });

            const setPrefs = pc.addedTransceivers[0].sender.setCodecPreferences;
            expect(setPrefs).toHaveBeenCalledTimes(1);
            const selected = setPrefs.mock.calls[0][0];
            // The regressed filter dropped rtx; the reorder must retain it.
            expect(selected.map((x: { mimeType: string }) => x.mimeType)).toEqual([
                "video/VP8",
                "video/H264",
                "video/rtx",
                "video/VP9"
            ]);
        } finally {
            if (original === undefined) delete (globalThis as any).RTCRtpSender;
            else (globalThis as any).RTCRtpSender = original;
        }
    });
});

describe("ButecoController transport fallback", () => {
    const ok = async () => ({ ok: true as const, value: undefined });
    const fail = (message: string) => async () => ({
        ok: false as const,
        error: { code: "sfu_unavailable" as const, message }
    });

    function setup(options: {
        order: Array<"mediamtx" | "cloudflare">;
        cloudflareStart?: () => Promise<any>;
        waitForConnected?: () => Promise<boolean>;
        publish?: ReturnType<typeof fakePublish>;
        onPhase?: (phase: any) => void;
        onTransportResult?: (transport: any, ok: boolean) => void;
    }) {
        const pc = fakePC();
        const display = fakeStream("vid1");
        const getDisplayMedia = vi.fn(async () => display);
        const cloudflareStart = vi.fn(options.cloudflareStart ?? ok);
        const cloudflareStop = vi.fn(async () => {});
        const unpublish = vi.fn(ok);
        const publish = options.publish ?? fakePublish();

        const controller = createButecoController({
            getSession: () => session,
            getDisplayMedia,
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish,
            unpublish,
            getScreenTransports: () => options.order,
            cloudflareScreen: { start: cloudflareStart, stop: cloudflareStop },
            waitForConnected: options.waitForConnected,
            onPhase: options.onPhase,
            onTransportResult: options.onTransportResult
        });
        return { controller, pc, display, getDisplayMedia, cloudflareStart, cloudflareStop, unpublish, publish };
    }

    it("publishes through Cloudflare first without opening a MediaMTX connection", async () => {
        const t = setup({ order: ["cloudflare", "mediamtx"] });

        expect((await t.controller.start({ ...baseOpts, mic: false })).ok).toBe(true);
        expect(t.cloudflareStart).toHaveBeenCalledWith(t.display.tracks[0], expect.objectContaining({ height: 1080 }));
        expect(t.publish).not.toHaveBeenCalled();
        expect(t.pc.addTransceiver).not.toHaveBeenCalled();

        await t.controller.stop();
        expect(t.cloudflareStop).toHaveBeenCalled();
        expect(t.unpublish).toHaveBeenCalled();
    });

    it("falls back to MediaMTX when Cloudflare fails, reusing the same capture", async () => {
        const t = setup({ order: ["cloudflare", "mediamtx"], cloudflareStart: fail("Cloudflare fora") });

        expect((await t.controller.start({ ...baseOpts, mic: false })).ok).toBe(true);
        expect(t.getDisplayMedia).toHaveBeenCalledTimes(1);
        expect(t.display.tracks[0].stop).not.toHaveBeenCalled();
        expect(t.cloudflareStop).toHaveBeenCalled();
        expect(t.publish).toHaveBeenCalledTimes(1);
        expect(t.pc.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "v=0 answer" });
    });

    it("falls back to Cloudflare when the MediaMTX media never connects", async () => {
        const t = setup({ order: ["mediamtx", "cloudflare"], waitForConnected: async () => false });

        expect((await t.controller.start({ ...baseOpts, mic: false })).ok).toBe(true);
        expect(t.pc.close).toHaveBeenCalled();
        expect(t.unpublish).toHaveBeenCalled();
        expect(t.cloudflareStart).toHaveBeenCalledTimes(1);
        expect(t.display.tracks[0].stop).not.toHaveBeenCalled();

        // O transporte que ficou ativo é o Cloudflare: parar solta a tela por ele.
        await t.controller.stop();
        expect(t.cloudflareStop).toHaveBeenCalled();
    });

    it("keeps MediaMTX when its media connects", async () => {
        const t = setup({ order: ["mediamtx", "cloudflare"], waitForConnected: async () => true });

        expect((await t.controller.start({ ...baseOpts, mic: false })).ok).toBe(true);
        expect(t.cloudflareStart).not.toHaveBeenCalled();
    });

    it("reports the last error and releases the capture when every transport fails", async () => {
        const t = setup({
            order: ["cloudflare", "mediamtx"],
            cloudflareStart: fail("Cloudflare fora"),
            waitForConnected: async () => false
        });

        const res = await t.controller.start({ ...baseOpts, mic: false });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("sfu_unavailable");
        expect(t.display.tracks[0].stop).toHaveBeenCalled();
        expect(t.unpublish).toHaveBeenCalled();
    });

    it("reports the capture phase, each connection attempt and its result", async () => {
        const onPhase = vi.fn();
        const onTransportResult = vi.fn();
        const t = setup({
            order: ["mediamtx", "cloudflare"],
            waitForConnected: async () => false,
            onPhase,
            onTransportResult
        });

        expect((await t.controller.start({ ...baseOpts, mic: false })).ok).toBe(true);
        expect(onPhase.mock.calls.map(([phase]) => phase)).toEqual([
            { step: "capture" },
            { step: "connecting", transport: "mediamtx", attempt: 1, total: 2 },
            { step: "connecting", transport: "cloudflare", attempt: 2, total: 2 }
        ]);
        expect(onTransportResult.mock.calls).toEqual([
            ["mediamtx", false],
            ["cloudflare", true]
        ]);
    });

    it("tries a refused MediaMTX publish and then the other transport", async () => {
        const refused = vi.fn(async () => ({
            ok: false as const,
            error: { code: "screen_taken" as const, message: "ocupada" }
        })) as any;
        const t = setup({ order: ["mediamtx", "cloudflare"], publish: refused });

        expect((await t.controller.start({ ...baseOpts, mic: false })).ok).toBe(true);
        expect(t.cloudflareStart).toHaveBeenCalledTimes(1);
    });
});

describe("reorderVideoCodecs", () => {
    it("keeps every codec, moving H264/VP8 and recovery codecs to the front", () => {
        const codecs = [
            { mimeType: "video/VP9" },
            { mimeType: "video/ulpfec" },
            { mimeType: "video/VP8" },
            { mimeType: "video/rtx", sdpFmtpLine: "apt=96" },
            { mimeType: "video/AV1" },
            { mimeType: "video/H264" }
        ];

        const result = reorderVideoCodecs(codecs);
        const mimes = result.map(c => c.mimeType);

        // Nothing is dropped: retransmission/recovery survives.
        expect(result).toHaveLength(codecs.length);
        expect(new Set(mimes)).toEqual(new Set(codecs.map(c => c.mimeType)));
        // H264/VP8 lead, with rtx/ulpfec right behind them.
        expect(mimes.slice(0, 3)).toEqual(["video/VP8", "video/H264", "video/ulpfec"]);
        expect(mimes).toContain("video/rtx");
        // Non-preferred codecs keep their relative order at the tail.
        expect(mimes.slice(-2)).toEqual(["video/VP9", "video/AV1"]);
    });

    it("leaves the list untouched when no preferred codec is present", () => {
        const codecs = [{ mimeType: "video/VP9" }, { mimeType: "video/rtx", sdpFmtpLine: "apt=98" }];
        expect(reorderVideoCodecs(codecs)).toEqual(codecs);
    });
});
