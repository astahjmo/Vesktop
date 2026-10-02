/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoIceServer } from "shared/buteco";
import type { ButecoSfuOp } from "shared/butecoWeb";

import { planSync, type PulledStream, pullLayer, streamKey, type StreamKind, type SyncMember } from "./sfuPlan";
import { encodingsFor, type SfuPreset } from "./sfuPresets";
import { createPlaceholderTrack, preferVp8, SfuError, waitForConnected, waitForIce } from "./sfuUtil";

/**
 * Sessão do SFU do Cloudflare (mesmo protocolo do site): um RTCPeerConnection
 * persistente por sala com dois slots de envio (câmera e tela) e transceivers
 * extras, só de recepção, para cada faixa remota puxada.
 *
 * - publicar: `camera|screen {on}` → o servidor devolve uma oferta → `renegotiate`;
 * - assistir: `pull {targets}` → oferta → `renegotiate`; `close {mids}` ao parar.
 */

export type SfuCall = (op: ButecoSfuOp, payload?: Record<string, unknown>) => Promise<any>;

export interface SfuEvents {
    onRemoteStream(userId: string, kind: StreamKind, stream: MediaStream | null): void;
    onBroken(): void;
}

export interface SfuSyncState {
    selfId: string;
    members: SyncMember[];
    wantCameras: boolean;
    wantScreensFrom: ReadonlySet<string>;
    focusedUserId?: string | null;
}

const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 4000;
const MAX_PULL_RETRIES = 3;
/** Acima disso a sessão acumulou transceivers demais e é refeita. */
const MAX_TRANSCEIVERS = 60;

export class SfuSession {
    readonly pc: RTCPeerConnection;

    private cameraTransceiver: RTCRtpTransceiver | null = null;
    private screenTransceiver: RTCRtpTransceiver | null = null;
    private cameraTrack: MediaStreamTrack | null = null;
    private screenTrack: MediaStreamTrack | null = null;

    private readonly pulled = new Map<string, PulledStream>();
    /** Chave `userId:kind` → `streamId` que falhou (espera o retry ou um stream novo). */
    private readonly failed = new Map<string, string>();
    private readonly retryAttempts = new Map<string, number>();
    private retryTimer: ReturnType<typeof setTimeout> | null = null;

    private latest: SfuSyncState | null = null;
    private syncQueued = false;
    private closed = false;
    private chain: Promise<unknown> = Promise.resolve();

    constructor(
        readonly roomId: string,
        iceServers: ButecoIceServer[],
        private readonly call: SfuCall,
        private readonly events: SfuEvents
    ) {
        this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });

        this.pc.ontrack = event => {
            const { mid } = event.transceiver;
            const pulled = mid ? this.pulled.get(mid) : undefined;
            if (pulled) this.events.onRemoteStream(pulled.userId, pulled.kind, new MediaStream([event.track]));
        };
        this.pc.onconnectionstatechange = () => {
            if (this.pc.connectionState === "failed") this.events.onBroken();
        };
    }

    get connected(): boolean {
        return this.cameraTransceiver !== null && this.screenTransceiver !== null;
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /** `true` quando a mídia da sessão está de fato conectada (ICE + DTLS). */
    waitForMedia(timeoutMs: number): Promise<boolean> {
        return waitForConnected(this.pc, timeoutMs);
    }

    /** Cria os dois slots de envio e abre a sessão no servidor (`connect`). */
    connect(cameraPreset: SfuPreset, screenPreset: SfuPreset): Promise<void> {
        return this.enqueue(async () => {
            if (this.cameraTransceiver || this.screenTransceiver) return;

            const placeholders = [createPlaceholderTrack(), createPlaceholderTrack()];
            try {
                const camera = this.pc.addTransceiver(this.cameraTrack ?? placeholders[0], {
                    direction: "sendonly",
                    sendEncodings: encodingsFor(cameraPreset)
                });
                const screen = this.pc.addTransceiver(this.screenTrack ?? placeholders[1], {
                    direction: "sendonly",
                    sendEncodings: encodingsFor(screenPreset)
                });
                preferVp8(camera);
                preferVp8(screen);

                await this.pc.setLocalDescription(await this.pc.createOffer());
                await waitForIce(this.pc);

                const cameraMid = camera.mid;
                const screenMid = screen.mid;
                const sdp = this.pc.localDescription?.sdp;
                if (!cameraMid || !screenMid || !sdp) throw new SfuError("Sessão de mídia inválida.", "generic");

                const answer = await this.call("connect", { sdp, mids: { camera: cameraMid, screen: screenMid } });
                await this.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });

                // Libera os slots: as faixas reais entram por replaceTrack.
                await camera.sender.replaceTrack(this.cameraTrack);
                await screen.sender.replaceTrack(this.screenTrack);

                this.cameraTransceiver = camera;
                this.screenTransceiver = screen;
                if (this.latest) this.requestSync(this.latest);
            } catch (error) {
                await this.rollback();
                throw error;
            } finally {
                for (const track of placeholders) track.stop();
            }
        });
    }

    setCameraTrack(track: MediaStreamTrack | null): Promise<void> {
        this.cameraTrack = track;
        if (!this.cameraTransceiver || this.closed) return Promise.resolve();
        return this.cameraTransceiver.sender.replaceTrack(track).catch(() => {});
    }

    setScreenTrack(track: MediaStreamTrack | null): Promise<void> {
        this.screenTrack = track;
        if (!this.screenTransceiver || this.closed) return Promise.resolve();
        return this.screenTransceiver.sender.replaceTrack(track).catch(() => {});
    }

    setServerCamera(on: boolean): Promise<void> {
        return this.setServerSlot("camera", on);
    }

    setServerScreen(on: boolean): Promise<void> {
        return this.setServerSlot("screen", on);
    }

    /** Ajusta bitrate/fps das camadas do slot de tela (ex.: ao trocar a qualidade). */
    applyScreenPreset(preset: SfuPreset): Promise<void> {
        return this.enqueue(() => this.applyPreset(this.screenTransceiver, preset));
    }

    /** Sincroniza o que está puxado com o que a sala oferece. */
    requestSync(state: SfuSyncState): void {
        this.latest = state;
        if (this.syncQueued || this.closed) return;

        this.syncQueued = true;
        this.enqueue(async () => {
            this.syncQueued = false;
            if (this.latest) await this.runSync(this.latest);
        }).catch(() => {});
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;

        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.pc.ontrack = null;
        this.pc.onconnectionstatechange = null;
        try {
            this.pc.close();
        } catch {
            // já fechado
        }

        for (const pulled of this.pulled.values()) this.events.onRemoteStream(pulled.userId, pulled.kind, null);
        this.pulled.clear();
        this.cameraTransceiver = null;
        this.screenTransceiver = null;
    }

    private enqueue<T>(task: () => Promise<T>): Promise<T> {
        const next = this.chain.then(() => {
            if (this.closed) throw new SfuError("Sessão de mídia encerrada.", "closed");
            return task();
        });
        this.chain = next.then(
            () => {},
            () => {}
        );
        return next;
    }

    private setServerSlot(op: "camera" | "screen", on: boolean): Promise<void> {
        return this.enqueue(async () => {
            const track = op === "camera" ? this.cameraTrack : this.screenTrack;
            const transceiver = op === "camera" ? this.cameraTransceiver : this.screenTransceiver;
            if (on && !track) return;
            if (on && !transceiver) throw new SfuError("Slot de mídia não conectado.", "generic");

            const result = await this.call(op, { on });
            if (result?.sdp) await this.answerRepublish(result.sdp);
        });
    }

    private async answerRepublish(sdp: string) {
        await this.pc.setRemoteDescription({ type: "offer", sdp });
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await waitForIce(this.pc);
        const answer = this.pc.localDescription?.sdp;
        if (!answer) throw new SfuError("Resposta de mídia inválida.", "generic");
        await this.call("renegotiate", { sdp: answer });
    }

    private async applyPreset(transceiver: RTCRtpTransceiver | null, preset: SfuPreset) {
        const sender = transceiver?.sender;
        if (!sender) return;

        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) return;

        const layers = new Map(preset.layers.map(layer => [layer.rid, layer]));
        for (const encoding of parameters.encodings) {
            const layer = encoding.rid ? layers.get(encoding.rid as "h" | "l") : undefined;
            if (!layer) continue;
            encoding.scaleResolutionDownBy = layer.scaleResolutionDownBy;
            encoding.maxBitrate = layer.maxBitrateKbps * 1000;
            encoding.maxFramerate = layer.maxFramerate;
        }
        await sender.setParameters(parameters).catch(() => {});
    }

    private async rollback() {
        try {
            if (this.pc.signalingState === "have-local-offer") {
                await this.pc.setLocalDescription({ type: "rollback" });
            } else if (this.pc.signalingState === "have-remote-offer") {
                await this.pc.setRemoteDescription({ type: "rollback" });
            }
        } catch {
            // nada a desfazer
        }
    }

    private async runSync(state: SfuSyncState) {
        if (!this.cameraTransceiver || !this.screenTransceiver) return;

        // Uma falha só vale para o stream que a causou: stream novo → tenta de novo.
        for (const [key, streamId] of this.failed) {
            const [userId, kind] = key.split(":") as [string, StreamKind];
            if (this.streamIdOf(state, userId, kind) !== streamId) this.clearFailure(key);
        }

        const plan = planSync({
            selfId: state.selfId,
            members: state.members,
            pulled: [...this.pulled.values()],
            skip: new Set(this.failed.keys()),
            wantCameras: state.wantCameras,
            wantScreensFrom: state.wantScreensFrom
        });
        const remoteCameras = state.members.filter(member => member.userId !== state.selfId && member.cameraId).length;

        try {
            if (plan.close.length) await this.closePulled(plan.close);
            if (plan.pull.length) await this.pullRemoteStreams(plan.pull, state, remoteCameras);
        } catch {
            await this.rollback();
            this.events.onBroken();
            return;
        }

        if (this.pc.getTransceivers().length > MAX_TRANSCEIVERS) this.events.onBroken();
    }

    private streamIdOf(state: SfuSyncState, userId: string, kind: StreamKind): string | null {
        const member = state.members.find(candidate => candidate.userId === userId);
        return (kind === "camera" ? member?.cameraId : member?.screenId) ?? null;
    }

    private async closePulled(mids: string[]) {
        for (const mid of mids) {
            const pulled = this.pulled.get(mid);
            this.pulled.delete(mid);
            if (pulled) this.events.onRemoteStream(pulled.userId, pulled.kind, null);
            this.pc
                .getTransceivers()
                .find(transceiver => transceiver.mid === mid)
                ?.stop();
        }

        await this.pc.setLocalDescription(await this.pc.createOffer());
        const sdp = this.pc.localDescription?.sdp;
        if (!sdp) throw new SfuError("Oferta de mídia inválida.", "generic");

        const answer = await this.call("close", { mids, sdp });
        await this.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    }

    private async pullRemoteStreams(
        targets: Array<{ userId: string; kind: StreamKind }>,
        state: SfuSyncState,
        remoteCameras: number
    ) {
        const layers = new Map<string, "h" | "l">();
        for (const target of targets) {
            if (!layers.has(target.userId)) {
                layers.set(
                    target.userId,
                    pullLayer({ remoteCameraCount: remoteCameras, focused: state.focusedUserId === target.userId })
                );
            }
        }
        const requested = targets.map(({ userId, kind }) => ({ userId, kind, rid: layers.get(userId) ?? "l" }));

        let response: {
            tracks: Array<{ userId: string; kind: StreamKind; mid: string; streamId: string }>;
            sdp?: string;
        };
        try {
            response = await this.call("pull", { targets: requested });
        } catch {
            this.markFailed(targets, state);
            return;
        }

        const ridByKey = new Map(requested.map(item => [streamKey(item.userId, item.kind), item.rid]));
        const arrived = new Set<string>();
        for (const track of response.tracks ?? []) {
            const key = streamKey(track.userId, track.kind);
            arrived.add(key);
            this.retryAttempts.delete(key);
            this.pulled.set(track.mid, {
                userId: track.userId,
                kind: track.kind,
                streamId: track.streamId,
                mid: track.mid,
                rid: ridByKey.get(key) ?? "l"
            });
        }

        const missing = targets.filter(target => !arrived.has(streamKey(target.userId, target.kind)));
        if (missing.length) this.markFailed(missing, state);
        if (!response.sdp) return;

        await this.pc.setRemoteDescription({ type: "offer", sdp: response.sdp });
        for (const transceiver of this.pc.getTransceivers()) {
            if (transceiver.mid && this.pulled.has(transceiver.mid)) preferVp8(transceiver);
        }
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await waitForIce(this.pc);
        const answer = this.pc.localDescription?.sdp;
        if (!answer) throw new SfuError("Resposta de mídia inválida.", "generic");
        await this.call("renegotiate", { sdp: answer });
    }

    private markFailed(targets: Array<{ userId: string; kind: StreamKind }>, state: SfuSyncState) {
        for (const target of targets) {
            const streamId = this.streamIdOf(state, target.userId, target.kind);
            if (streamId) this.failed.set(streamKey(target.userId, target.kind), streamId);
        }
        this.scheduleRetry();
    }

    private clearFailure(key: string) {
        this.failed.delete(key);
        this.retryAttempts.delete(key);
    }

    private scheduleRetry() {
        if (this.closed || this.retryTimer) return;

        let delay: number | null = null;
        for (const key of this.failed.keys()) {
            const attempts = this.retryAttempts.get(key) ?? 0;
            if (attempts >= MAX_PULL_RETRIES) continue;
            const wait = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS);
            if (delay === null || wait < delay) delay = wait;
        }
        if (delay === null) return;

        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.closed || !this.latest) return;

            for (const key of this.failed.keys()) {
                this.retryAttempts.set(key, (this.retryAttempts.get(key) ?? 0) + 1);
            }
            for (const key of [...this.failed.keys()]) this.failed.delete(key);

            const state = this.latest;
            this.enqueue(async () => {
                if (this.latest) await this.runSync(state);
            }).catch(() => {});
        }, delay);
    }
}
