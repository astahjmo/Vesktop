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
    row.style.cssText = "width:100%;display:flex;justify-content:center;padding:2px 0;";

    const tile = document.createElement("div");
    tile.style.cssText =
        "position:relative;width:100%;max-width:1200px;aspect-ratio:16/9;background:#000;" +
        "border-radius:8px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.06) inset;";

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

    tile.append(video, badge);
    row.append(tile);
    grid.prepend(row);

    return video;
}

function stopWatching() {
    pc?.close();
    pc = null;
    activeUserId = null;
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

    connection.addTransceiver("video", { direction: "recvonly" });
    connection.addTransceiver("audio", { direction: "recvonly" });

    connection.ontrack = event => {
        stream.addTrack(event.track);
        const el = ensureTile(name);
        if (!el) return;

        el.srcObject = stream;
        void el.play().catch(() => {
            // Autoplay com áudio pode ser bloqueado; cai para mudo e tenta de novo.
            el.muted = true;
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

    sync();
});
