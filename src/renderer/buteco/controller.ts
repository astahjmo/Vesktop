/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
    ButecoError,
    ButecoIceServer,
    ButecoPublishMeta,
    ButecoPublishResult,
    ButecoResult,
    ButecoSession
} from "shared/buteco";

import type { PublishPhase } from "./publishProgress";
import type { ScreenTransport } from "./screenTransport";

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
    /**
     * Ordem de tentativa dos transportes de tela. Sem isso só o MediaMTX é usado
     * (comportamento original); quando o primeiro falha, tenta o seguinte.
     */
    getScreenTransports?(): ScreenTransport[];
    /** Publicação da tela pelo SFU do Cloudflare (só vídeo; o áudio não vai por ele). */
    cloudflareScreen?: {
        start(track: MediaStreamTrack, opts: StartOptions): Promise<ButecoResult<void>>;
        stop(): Promise<void>;
    };
    /** Em que fase está o início da transmissão (a UI mostra um carregamento). */
    onPhase?(phase: PublishPhase): void;
    /** Resultado de cada tentativa de transporte (alimenta a ordem das próximas). */
    onTransportResult?(transport: ScreenTransport, ok: boolean): void;
    /** Espera a mídia do PC do MediaMTX conectar; sem isso a publicação não é validada. */
    waitForConnected?(pc: RTCPeerConnection): Promise<boolean>;
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
    let display: MediaStream | null = null;
    /** Microfone e áudio de app: pertencem à tentativa do MediaMTX. */
    let audioStreams: MediaStream[] = [];
    let usingVirtmic = false;
    let activeTransport: ScreenTransport | null = null;

    /** Desfaz só o que a tentativa do MediaMTX criou, mantendo a captura para outro transporte. */
    async function cleanupMediamtxAttempt() {
        audioStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
        audioStreams = [];
        pc?.close();
        pc = null;
        if (usingVirtmic) {
            usingVirtmic = false;
            await deps.virtmic?.stop().catch(() => {});
        }
    }

    async function stop() {
        const transport = activeTransport;
        activeTransport = null;

        display?.getTracks().forEach(t => t.stop());
        display = null;
        await cleanupMediamtxAttempt();
        if (transport === "cloudflare") await deps.cloudflareScreen?.stop().catch(() => {});
        await deps.unpublish().catch(() => {});
    }

    async function startMediamtx(
        session: ButecoSession,
        stream: MediaStream,
        videoTrack: MediaStreamTrack,
        opts: StartOptions
    ): Promise<ButecoResult<void>> {
        pc = deps.createPeerConnection(session.iceServers);
        const { sender } = pc.addTransceiver(videoTrack, { direction: "sendonly", streams: [stream] });
        preferH264Vp8(sender);

        const audioAllowed = session.limits.screenAudioAllowed;
        let audioLabel: string | null = null;
        let micEnabled = false;

        if (audioAllowed && opts.mic) {
            const mic = await deps.getUserMedia({ audio: true, video: false });
            audioStreams.push(mic);
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
            audioStreams.push(appAudio);
            const appTrack = appAudio.getAudioTracks()[0];
            if (appTrack) {
                pc.addTransceiver(appTrack, { direction: "sendonly", streams: [appAudio] });
                audioLabel = opts.audioLabel ?? VIRT_MIC_LABEL;
            }
        }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const sdp = pc.localDescription?.sdp ?? offer.sdp;
        if (!sdp) return { ok: false, error: { code: "video_capture_failed", message: "Falha ao preparar SDP." } };

        const meta: ButecoPublishMeta = {
            videoKind: opts.videoKind,
            videoLabel: opts.videoLabel,
            audioLabel,
            mic: micEnabled,
            height: opts.height,
            fps: opts.fps
        };

        const res = await deps.publish(sdp, meta);
        if (!res.ok) return res;

        await pc.setRemoteDescription({ type: "answer", sdp: res.value.sdp });

        // O servidor aceitou, mas sem ICE a mídia nunca chega (o selo "ao vivo" seria falso).
        if (deps.waitForConnected && !(await deps.waitForConnected(pc))) {
            return {
                ok: false,
                error: { code: "sfu_unavailable", message: "Sem conexão com o servidor de mídia (MediaMTX)." }
            };
        }
        return { ok: true, value: undefined };
    }

    async function startCloudflare(videoTrack: MediaStreamTrack, opts: StartOptions): Promise<ButecoResult<void>> {
        if (!deps.cloudflareScreen) {
            return { ok: false, error: { code: "unsupported", message: "Cloudflare indisponível." } };
        }
        return deps.cloudflareScreen.start(videoTrack, opts);
    }

    async function start(opts: StartOptions): Promise<ButecoResult<void>> {
        const session = deps.getSession();
        if (!session) return { ok: false, error: { code: "token_invalid", message: "Sem sessão." } };

        try {
            deps.onPhase?.({ step: "capture" });
            const captured = await deps.getDisplayMedia({ video: true, audio: false });
            display = captured;
            const videoTrack = captured.getVideoTracks()[0];
            if (!videoTrack) {
                await stop();
                return { ok: false, error: { code: "video_capture_failed", message: "Sem vídeo." } };
            }
            videoTrack.contentHint = opts.contentHint ?? "motion";

            // The OS/Chromium "Stop sharing" gesture ends the display track.
            // Tear the whole publish down (unpublish included) so we don't keep
            // advertising `live` with a dead track.
            videoTrack.addEventListener("ended", () => void stop());

            const order = deps.getScreenTransports?.() ?? ["mediamtx"];
            let lastError: ButecoError | null = null;

            for (const [index, transport] of order.entries()) {
                deps.onPhase?.({ step: "connecting", transport, attempt: index + 1, total: order.length });
                const result =
                    transport === "cloudflare"
                        ? await startCloudflare(videoTrack, opts)
                        : await startMediamtx(session, captured, videoTrack, opts);

                deps.onTransportResult?.(transport, result.ok);
                if (result.ok) {
                    activeTransport = transport;
                    return result;
                }

                lastError = result.error;
                // Limpa só a tentativa que falhou: a captura segue para o próximo transporte.
                if (transport === "cloudflare") await deps.cloudflareScreen?.stop().catch(() => {});
                else {
                    await cleanupMediamtxAttempt();
                    await deps.unpublish().catch(() => {});
                }
            }

            await stop();
            return {
                ok: false,
                error: lastError ?? { code: "video_capture_failed", message: "Falha ao iniciar captura." }
            };
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
