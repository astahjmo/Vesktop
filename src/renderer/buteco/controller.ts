/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
    ButecoIceServer,
    ButecoPublishMeta,
    ButecoPublishResult,
    ButecoResult,
    ButecoSession
} from "shared/buteco";

export interface StartOptions {
    sourceId: string;
    videoKind: "screen" | "window";
    videoLabel: string;
    height: 720 | 1080 | 1440;
    fps: 30 | 60;
    mic: boolean;
    /** Track content hint selected in the picker; defaults to "motion". */
    contentHint?: string;
    audioLabel?: string | null;
    includeAudioNodes?: unknown[];
}

export interface ControllerDeps {
    getSession(): ButecoSession | null;
    getDisplayMedia(opts: MediaStreamConstraints): Promise<MediaStream>;
    getUserMedia(opts: MediaStreamConstraints): Promise<MediaStream>;
    createPeerConnection(iceServers: ButecoIceServer[]): RTCPeerConnection;
    publish(sdp: string, meta: ButecoPublishMeta): Promise<ButecoResult<ButecoPublishResult>>;
    unpublish(): Promise<ButecoResult<void>>;
    getVirtmicDeviceId?(): Promise<string | null>;
    virtmic?: {
        start(nodes: unknown[]): Promise<void>;
        stop(): Promise<void>;
        /**
         * Unmutes the virtual sink. `buildLinkData` mutes it by default and the
         * native flow only unmutes from the Discord `STREAM_UPDATE` handler,
         * which never fires in Buteco mode — without this the published app
         * audio is silent. Optional so existing wiring/tests keep working.
         */
        unmute?(): Promise<void>;
    };
}

export interface ButecoController {
    start(opts: StartOptions): Promise<ButecoResult<void>>;
    stop(): Promise<void>;
    getConnection(): RTCPeerConnection | null;
}

const VIRT_MIC_LABEL = "vencord-screen-share";

export function createButecoController(deps: ControllerDeps): ButecoController {
    let pc: RTCPeerConnection | null = null;
    const streams: MediaStream[] = [];
    let usingVirtmic = false;

    async function stop() {
        streams.forEach(s => s.getTracks().forEach(t => t.stop()));
        streams.length = 0;
        pc?.close();
        pc = null;
        if (usingVirtmic) {
            usingVirtmic = false;
            await deps.virtmic?.stop().catch(() => {});
        }
        await deps.unpublish().catch(() => {});
    }

    async function start(opts: StartOptions): Promise<ButecoResult<void>> {
        const session = deps.getSession();
        if (!session) return { ok: false, error: { code: "token_invalid", message: "Sem sessão." } };

        try {
            const display = await deps.getDisplayMedia({ video: true, audio: false });
            streams.push(display);
            const videoTrack = display.getVideoTracks()[0];
            if (!videoTrack) {
                await stop();
                return { ok: false, error: { code: "video_capture_failed", message: "Sem vídeo." } };
            }
            videoTrack.contentHint = opts.contentHint ?? "motion";

            pc = deps.createPeerConnection(session.iceServers);
            const { sender } = pc.addTransceiver(videoTrack, { direction: "sendonly", streams: [display] });
            preferH264Vp8(sender);

            // The OS/Chromium "Stop sharing" gesture ends the display track.
            // Tear the whole publish down (unpublish included) so we don't keep
            // advertising `live` with a dead track.
            videoTrack.addEventListener("ended", () => void stop());

            const audioAllowed = session.limits.screenAudioAllowed;
            let audioLabel: string | null = null;
            let micEnabled = false;

            if (audioAllowed && opts.mic) {
                const mic = await deps.getUserMedia({ audio: true, video: false });
                streams.push(mic);
                const micTrack = mic.getAudioTracks()[0];
                if (micTrack) {
                    pc.addTransceiver(micTrack, { direction: "sendonly", streams: [mic] });
                    micEnabled = true;
                }
            }

            if (audioAllowed && opts.includeAudioNodes?.length && deps.virtmic) {
                await deps.virtmic.start(opts.includeAudioNodes);
                usingVirtmic = true;
                // No Discord stream exists in Buteco mode, so the native
                // STREAM_UPDATE → unlock flow never runs; unmute here or the
                // captured app audio publishes silent.
                await deps.virtmic.unmute?.().catch(() => {});
                const devId = (await deps.getVirtmicDeviceId?.()) ?? VIRT_MIC_LABEL;
                const appAudio = await deps.getUserMedia({
                    audio: {
                        deviceId: { exact: devId },
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false
                    },
                    video: false
                });
                streams.push(appAudio);
                const appTrack = appAudio.getAudioTracks()[0];
                if (appTrack) {
                    pc.addTransceiver(appTrack, { direction: "sendonly", streams: [appAudio] });
                    audioLabel = opts.audioLabel ?? VIRT_MIC_LABEL;
                }
            }

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            const sdp = pc.localDescription?.sdp ?? offer.sdp;
            if (!sdp) {
                await stop();
                return { ok: false, error: { code: "video_capture_failed", message: "Falha ao preparar SDP." } };
            }

            const meta: ButecoPublishMeta = {
                videoKind: opts.videoKind,
                videoLabel: opts.videoLabel,
                audioLabel,
                mic: micEnabled,
                height: opts.height,
                fps: opts.fps
            };

            const res = await deps.publish(sdp, meta);
            if (!res.ok) {
                await stop();
                return res;
            }

            await pc.setRemoteDescription({ type: "answer", sdp: res.value.sdp });
            return { ok: true, value: undefined };
        } catch {
            await stop();
            return { ok: false, error: { code: "video_capture_failed", message: "Falha ao iniciar captura." } };
        }
    }

    return { start, stop, getConnection: () => pc };
}

interface RtpCodecCapability {
    mimeType: string;
    sdpFmtpLine?: string;
}

/** Primary screen-share MIME payloads to move to the front. */
const PREFERRED_MIME = /H264|VP8/i;

/**
 * Retransmission / recovery codecs. `rtx` additionally carries its associated
 * primary codec's payload type in `a=fmtp:<pt> apt=<pt>`, which Chromium
 * exposes as `sdpFmtpLine: "apt=<n>"`.
 */
const RECOVERY_MIME = /rtx|red|ulpfec/i;

function isRecoveryCodec(codec: RtpCodecCapability) {
    return RECOVERY_MIME.test(codec.mimeType) || /(?:^|;)\s*apt=\d+/.test(codec.sdpFmtpLine ?? "");
}

/**
 * Moves H264/VP8 (and their `rtx`/`red`/`ulpfec` recovery codecs) to the front,
 * appending every remaining codec in its original relative order. The previous
 * `filter` implementation dropped `rtx`/`red`/`ulpfec`, disabling
 * retransmission and loss recovery for the published video.
 */
export function reorderVideoCodecs<T extends RtpCodecCapability>(codecs: T[]): T[] {
    const preferred: T[] = [];
    const recovery: T[] = [];
    const rest: T[] = [];

    for (const codec of codecs) {
        if (PREFERRED_MIME.test(codec.mimeType)) preferred.push(codec);
        else if (isRecoveryCodec(codec)) recovery.push(codec);
        else rest.push(codec);
    }

    // No preferred primary codec: leave the list untouched so we do not reorder
    // recovery codecs into a position their `apt` target does not occupy.
    if (!preferred.length) return codecs.slice();

    return [...preferred, ...recovery, ...rest];
}

function preferH264Vp8(sender: RTCRtpSender) {
    const RtpSender = (
        globalThis as { RTCRtpSender?: { getCapabilities?: (kind: string) => { codecs?: RtpCodecCapability[] } } }
    ).RTCRtpSender;
    const codecs = RtpSender?.getCapabilities?.("video")?.codecs;
    const { setCodecPreferences } = sender as { setCodecPreferences?: (codecs: RtpCodecCapability[]) => void };
    if (!codecs?.length || !setCodecPreferences) return;
    setCodecPreferences.call(sender, reorderVideoCodecs(codecs));
}
