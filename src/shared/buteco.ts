/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const BUTECO_APP_BASE = "https://games.butecodosdevs.com";
export const BUTECO_PROTOCOL = 1;
export const BUTECO_REQUEST_TIMEOUT_MS = 15_000;

export type ButecoPhase =
    "idle" | "pairing" | "ready" | "selecting" | "starting" | "live" | "reconnecting" | "stopping";

export interface ButecoLimits {
    screenAudioAllowed: boolean;
    maxHeight: 720 | 1080 | 1440;
    maxFps: 30 | 60;
    maxVideoKbps: number;
    audioKbps: number;
}

export interface ButecoIceServer {
    urls: string | string[];
    username?: string;
    credential?: string;
}

export interface ButecoTakenBy {
    userId: string;
    displayName: string;
    self: boolean;
}

export interface ButecoRoom {
    id: string;
    slug: string;
    name: string;
    url?: string;
}

export interface ButecoSession {
    token: string;
    tokenExpiresAt: string;
    room: ButecoRoom;
    user: { id: string; displayName: string };
    socket: { url: string; path: "/socket.io"; namespace: "/helper" };
    iceServers: ButecoIceServer[];
    limits: ButecoLimits;
    screen: { takenBy: ButecoTakenBy | null };
    serverNow: string;
}

export interface ButecoPublishMeta {
    videoKind: "screen" | "window";
    videoLabel: string;
    audioLabel: string | null;
    mic: boolean;
    height: 720 | 1080 | 1440;
    fps: 30 | 60;
}

export interface ButecoPublishResult {
    sdp: string;
    streamId: string;
}

export interface ButecoSource {
    id: string;
    name: string;
    kind: "screen" | "window";
    thumbnailDataUrl?: string;
}

const KNOWN_ERROR_CODES = [
    "invalid_code_format",
    "token_invalid",
    "client_outdated",
    "network",
    "unsupported",
    "permission_denied",
    "video_capture_failed",
    "screen_audio_disabled",
    "screen_taken",
    "screen_taken_self",
    "sfu_unavailable",
    "device_error",
    "busy"
] as const;

export type ButecoErrorCode = (typeof KNOWN_ERROR_CODES)[number];

export interface ButecoError {
    code: ButecoErrorCode;
    message: string;
    retryAfterSec?: number;
}

export type ButecoResult<T> = { ok: true; value: T } | { ok: false; error: ButecoError };

export type ButecoEvent =
    | { type: "connection"; state: "connected" | "reconnecting" | "offline" }
    | { type: "revoked"; reason: string }
    | { type: "stop_requested"; by: "owner" | "room_owner" | "admin" }
    | { type: "screen_lost"; reason: "sfu_error" | "reset" | "taken_over" }
    | { type: "session"; session: ButecoSession };

/** Maps an HTTP refusal from the Ground into a stable client error. */
export function mapGroundRefusal(status: number, body: any, retryAfter?: string | null): ButecoError {
    const serverCode = typeof body?.error === "string" ? body.error : undefined;
    // Endpoints do SFU de câmera respondem o motivo (busy/full/blocked/...) em `reason`.
    const serverReason = typeof body?.reason === "string" ? body.reason : undefined;
    const code: ButecoErrorCode =
        serverCode && (KNOWN_ERROR_CODES as readonly string[]).includes(serverCode)
            ? (serverCode as ButecoErrorCode)
            : status === 401
              ? "token_invalid"
              : status === 426
                ? "client_outdated"
                : status === 409
                  ? "screen_taken"
                  : "network";

    const error: ButecoError = { code, message: serverCode ?? serverReason ?? `HTTP ${status}` };
    if (code === "busy" && retryAfter) {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs)) error.retryAfterSec = secs;
    }
    return error;
}
