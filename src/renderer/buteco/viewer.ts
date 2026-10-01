/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { onceReady } from "@vencord/types/webpack";
import type { ButecoIceServer, ButecoResult } from "shared/buteco";

import { findRoomStream, getButecoWebState, subscribeButecoWeb } from "./webState";

const ROW_ID = "vc-buteco-stream-row";
const BADGE_CLASS = "vc-buteco-stream-badge";

let pc: RTCPeerConnection | null = null;
let activeUserId: string | null = null;
let failedUserId: string | null = null;
let row: HTMLDivElement | null = null;
let video: HTMLVideoElement | null = null;
let focused = false;

// Handle de diagnóstico (console/CDP): __butecoViewer.pc.getStats().
(globalThis as any).__butecoViewer = {
    get pc() {
        return pc;
    },
    get video() {
        return video;
    }
};

function removeTile() {
    row?.remove();
    row = null;
    video = null;
}

/** A grade da call vive sob um scroller com "videoGrid"; as linhas, em "listItems". */
function findCallGrid(): HTMLElement | null {
    return (
        document.querySelector<HTMLElement>('[class*="videoGrid"] [class*="listItems"]') ??
        document.querySelector<HTMLElement>('[class*="videoGrid"]')
    );
}

/** Mede um tile nativo do Discord para o nosso ter o mesmo tamanho. */
function nativeTileSize(): { width?: number; height?: number } {
    const native = document.querySelector<HTMLElement>('[class*="tileSizer"]');
    const rect = native?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
    }
    return {};
}

function applyFocus() {
    if (!row || !video) return;
    const tile = video.parentElement as HTMLDivElement | null;
    if (!tile) return;

    if (focused) {
        // Cobre a área da call (não mexe na grade do Discord).
        const area =
            document.querySelector<HTMLElement>('[class*="videoControls"]') ??
            document.querySelector<HTMLElement>('[class*="callContainer"]');
        const rect = area?.getBoundingClientRect();
        const left = rect ? rect.left : 326;
        const top = rect ? rect.top : 32;
        const width = rect ? rect.width : window.innerWidth - 326;
        const height = rect ? rect.height : window.innerHeight - 32;

        row.style.cssText =
            `position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px;z-index:120;` +
            "display:flex;align-items:center;justify-content:center;padding:8px;box-sizing:border-box;";
        tile.style.cssText =
            "position:relative;width:100%;height:100%;max-width:none;aspect-ratio:auto;background:#000;" +
            "border-radius:8px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.06) inset;";
        return;
    }

    const size = nativeTileSize();
    row.style.cssText = "width:100%;display:flex;justify-content:center;padding:2px 0;box-sizing:border-box;";
    tile.style.cssText =
        "position:relative;background:#000;border-radius:8px;overflow:hidden;" +
        "box-shadow:0 0 0 1px rgba(255,255,255,.06) inset;" +
        (size.width && size.height
            ? `width:${size.width}px;height:${size.height}px;`
            : "width:100%;max-width:1200px;aspect-ratio:16/9;");
}

function ensureTile(name: string): HTMLVideoElement | null {
    if (video && row && document.contains(row)) {
        const badge = row.querySelector<HTMLElement>(`.${BADGE_CLASS}`);
        if (badge) badge.textContent = `Buteco Games · ${name}`;
        return video;
    }

    removeTile();

    const grid = findCallGrid();
    if (!grid) return null;

    row = document.createElement("div");
    row.id = ROW_ID;

    const tile = document.createElement("div");
    tile.id = "vc-buteco-stream-tile";
    tile.title = "Clique para maximizar / restaurar";
    tile.style.cursor = "pointer";

    video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText = "width:100%;height:100%;object-fit:contain;background:#000;";

    const badge = document.createElement("div");
    badge.className = BADGE_CLASS;
    badge.textContent = `Buteco Games · ${name}`;
    badge.style.cssText =
        "position:absolute;left:8px;top:8px;padding:2px 8px;border-radius:999px;" +
        "background:rgba(0,0,0,.65);color:#fff;font-size:12px;font-weight:600;pointer-events:none;";

    const mute = document.createElement("button");
    mute.id = "vc-buteco-stream-mute";
    mute.type = "button";
    mute.textContent = video.muted ? "🔇" : "🔊";
    mute.title = "Alternar áudio";
    mute.style.cssText =
        "position:absolute;right:8px;top:8px;width:28px;height:28px;border-radius:6px;border:none;" +
        "background:rgba(0,0,0,.65);color:#fff;cursor:pointer;font-size:14px;line-height:1;";
    mute.addEventListener("click", event => {
        event.stopPropagation();
        if (!video) return;
        video.muted = !video.muted;
        mute.textContent = video.muted ? "🔇" : "🔊";
    });

    tile.addEventListener("click", () => {
        focused = !focused;
        applyFocus();
    });

    tile.append(video, badge, mute);
    row.append(tile);
    grid.prepend(row);
    applyFocus();

    return video;
}

function stopWatching() {
    pc?.close();
    pc = null;
    activeUserId = null;
    focused = false;
    removeTile();
}

async function startWatching(userId: string, name: string) {
    stopWatching();
    activeUserId = userId;

    const ice = (await VesktopNative.buteco.web.ice()) as ButecoResult<ButecoIceServer[]>;
    if (!ice.ok || activeUserId !== userId) {
        activeUserId = null;
        failedUserId = userId;
        return;
    }

    const connection = new RTCPeerConnection({ iceServers: ice.value, bundlePolicy: "max-bundle" });
    pc = connection;
    const stream = new MediaStream();

    // H264/VP8 primeiro: decode mais leve que VP9/AV1 (evita frame drops).
    const videoTransceiver = connection.addTransceiver("video", { direction: "recvonly" });
    const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs;
    if (codecs?.length && videoTransceiver.setCodecPreferences) {
        const preferred = codecs.filter(codec => /H264|VP8/i.test(codec.mimeType));
        if (preferred.length) videoTransceiver.setCodecPreferences(preferred);
    }
    connection.addTransceiver("audio", { direction: "recvonly" });

    connection.ontrack = event => {
        stream.addTrack(event.track);
        const el = ensureTile(name);
        if (!el) return;

        el.srcObject = stream;
        void el.play().catch(() => {
            // Autoplay com áudio pode ser bloqueado; cai para mudo e tenta de novo.
            el.muted = true;
            const mute = el.parentElement?.querySelector<HTMLButtonElement>("#vc-buteco-stream-mute");
            if (mute) mute.textContent = "🔇";
            void el.play().catch(() => {});
        });
    };

    connection.onconnectionstatechange = () => {
        if (connection.connectionState === "failed") {
            failedUserId = userId;
            stopWatching();
        }
    };

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    const sdp = connection.localDescription?.sdp;
    if (!sdp || pc !== connection) {
        stopWatching();
        return;
    }

    const answer = (await VesktopNative.buteco.web.whep(sdp)) as ButecoResult<{ sdp: string }>;
    if (pc !== connection) return;
    if (!answer.ok || !answer.value?.sdp) {
        failedUserId = userId;
        stopWatching();
        return;
    }

    await connection.setRemoteDescription({ type: "answer", sdp: answer.value.sdp });
}

function sync() {
    const member = findRoomStream(getButecoWebState().room);

    if (!member) {
        failedUserId = null;
        if (activeUserId) stopWatching();
        else removeTile();
        return;
    }

    if (member.userId === failedUserId) return;
    if (member.userId === activeUserId) {
        // React pode ter derrubado a grade; recoloca o tile.
        if (!row || !document.contains(row)) ensureTile(member.displayName);
        return;
    }

    void startWatching(member.userId, member.displayName);
}

onceReady.then(() => {
    subscribeButecoWeb(sync);

    // O React re-renderiza a grade com frequência; se nosso tile sumir, volta.
    const observer = new MutationObserver(() => {
        if (!pc || !activeUserId) return;
        if (!row || !document.contains(row)) {
            ensureTile(findRoomStream(getButecoWebState().room)?.displayName ?? "Buteco");
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener("resize", () => {
        if (focused) applyFocus();
    });

    // A grade do Discord muda de tamanho sozinha (entra/sai gente, resize);
    // reaplica o tamanho nativo periodicamente enquanto não estamos focados.
    setInterval(() => {
        if (!focused && row && document.contains(row)) applyFocus();
    }, 1500);

    sync();
});
