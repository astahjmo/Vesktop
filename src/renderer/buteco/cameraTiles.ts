/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { onceReady } from "@vencord/types/webpack";
import { UserStore } from "@vencord/types/webpack/common";

import { getLocalCameraStream, subscribeButecoCamera } from "./cameraSession";
import { resolveDiscordUserId } from "./discordBridge";
import { getRemoteStream, subscribeRemoteStreams } from "./sfu";
import { getButecoWebState } from "./webState";

/**
 * Câmera do Buteco dentro dos tiles do próprio Discord: o vídeo entra no
 * `content` do tile do usuário (por cima do avatar, abaixo do nome e dos
 * indicadores), como a câmera nativa. Outras fontes de câmera podem se
 * registrar com `setUserCameraStream`.
 */

const VIDEO_ATTR = "data-vc-buteco-camera";

const streams = new Map<string, MediaStream>();

export function setUserCameraStream(discordUserId: string, stream: MediaStream | null) {
    if (stream) streams.set(discordUserId, stream);
    else streams.delete(discordUserId);
    sync();
}

/** O tile do usuário na grade/foco/filme-strip; o do stream falso (botão Watch) não conta. */
function userTiles(userId: string): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(`[data-selenium-video-tile="${userId}"]`)].filter(
        tile => !/watch/i.test(tile.textContent || "")
    );
}

function sync() {
    // 1) remove vídeos de quem não tem mais câmera (ou de tiles que mudaram)
    for (const video of document.querySelectorAll<HTMLVideoElement>(`video[${VIDEO_ATTR}]`)) {
        const owner = video.getAttribute(VIDEO_ATTR) ?? "";
        const stream = streams.get(owner);
        const tile = video.closest<HTMLElement>("[data-selenium-video-tile]");
        if (
            !stream ||
            video.srcObject !== stream ||
            !tile ||
            tile.getAttribute("data-selenium-video-tile") !== owner ||
            /watch/i.test(tile.textContent || "")
        ) {
            video.remove();
        }
    }

    // 2) garante um vídeo por tile de cada usuário com câmera
    for (const [userId, stream] of streams) {
        for (const tile of userTiles(userId)) {
            const content = tile.querySelector<HTMLElement>('[class*="content_"]');
            if (!content || content.querySelector(`video[${VIDEO_ATTR}]`)) continue;

            const video = document.createElement("video");
            video.setAttribute(VIDEO_ATTR, userId);
            video.muted = true;
            video.autoplay = true;
            video.playsInline = true;
            video.srcObject = stream;
            video.style.cssText =
                "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;pointer-events:none;";
            content.appendChild(video);
            void video.play().catch(() => {});
        }
    }
}

/** Câmeras de outros membros: id do site → usuário do Discord a quem o vídeo pertence. */
const remoteOwners = new Map<string, string>();

/** Liga a câmera remota ao tile da pessoa; se a ponte ainda não casou o nome, tenta de novo depois. */
function applyRemoteCamera(siteUserId: string, stream: MediaStream | null) {
    const previous = remoteOwners.get(siteUserId);

    if (!stream) {
        if (previous) setUserCameraStream(previous, null);
        remoteOwners.delete(siteUserId);
        return;
    }

    const member = getButecoWebState().room?.members.find(candidate => candidate.userId === siteUserId);
    const discordUserId = member ? resolveDiscordUserId(siteUserId, member.displayName) : null;
    if (!discordUserId) return;

    if (previous && previous !== discordUserId) setUserCameraStream(previous, null);
    remoteOwners.set(siteUserId, discordUserId);
    setUserCameraStream(discordUserId, stream);
}

/** Reaplica as câmeras remotas que chegaram antes de a pessoa estar na call (ponte sem casar). */
function retryUnmatchedRemotes() {
    for (const member of getButecoWebState().room?.members ?? []) {
        if (member.cameraId && !remoteOwners.has(member.userId)) {
            const stream = getRemoteStream(member.userId, "camera");
            if (stream) applyRemoteCamera(member.userId, stream);
        }
    }
}

function syncSelf() {
    const selfId = UserStore.getCurrentUser()?.id;
    if (!selfId) return;
    setUserCameraStream(selfId, getLocalCameraStream());
}

onceReady.then(() => {
    subscribeButecoCamera(syncSelf);
    subscribeRemoteStreams((siteUserId, kind, stream) => {
        if (kind === "camera") applyRemoteCamera(siteUserId, stream);
    });
    // O React remonta os tiles a cada mudança de layout.
    new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
        retryUnmatchedRemotes();
        sync();
    }, 1000);
});
