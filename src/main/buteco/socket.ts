/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BUTECO_PROTOCOL, type ButecoEvent, type ButecoPhase } from "shared/buteco";
import { io as defaultIo } from "socket.io-client";

const STATUS_MIN_INTERVAL_MS = 1000;

export interface ConnectHelperOptions {
    url: string;
    token: string;
    ioImpl?: typeof defaultIo;
    onEvent: (event: ButecoEvent) => void;
}

export interface HelperConnection {
    sendStatus(phase: ButecoPhase, now?: number): boolean;
    close(): void;
}

export function connectHelper(opts: ConnectHelperOptions): HelperConnection {
    const ioImpl = opts.ioImpl ?? defaultIo;
    const socket = ioImpl(`${opts.url.replace(/\/$/, "")}/helper`, {
        path: "/socket.io",
        auth: { token: opts.token, protocol: BUTECO_PROTOCOL },
        transports: ["websocket"],
        reconnection: true,
        reconnectionDelayMax: 10_000
    });

    let closed = false;
    let lastStatusAt = Number.NEGATIVE_INFINITY;
    let pending: ButecoPhase | null = null;

    const emitStatus = (phase: ButecoPhase, now: number) => {
        lastStatusAt = now;
        socket.emit("helper:status", phase);
    };

    socket.on("connect", () => {
        opts.onEvent({ type: "connection", state: "connected" });
        if (pending) {
            emitStatus(pending, Date.now());
            pending = null;
        }
    });

    socket.on("disconnect", (reason: string) => {
        if (closed || reason === "io client disconnect") return;
        opts.onEvent({ type: "connection", state: reason === "io server disconnect" ? "offline" : "reconnecting" });
    });

    socket.io.on("reconnect_failed", () => opts.onEvent({ type: "connection", state: "offline" }));

    socket.on("connect_error", (err: Error) => {
        if (err.message === "token_invalid" || err.message === "client_outdated") {
            closed = true;
            socket.disconnect();
            opts.onEvent({ type: "connection", state: "offline" });
        }
    });

    socket.on("helper:session", (p: any) => {
        if (p?.room) opts.onEvent({ type: "session", session: p });
    });
    socket.on("helper:revoked", (p: any) => {
        if (p?.reason) opts.onEvent({ type: "revoked", reason: p.reason });
    });
    socket.on("helper:stop_requested", (p: any) => {
        if (p?.by) opts.onEvent({ type: "stop_requested", by: p.by });
    });
    socket.on("helper:screen_lost", (p: any) => {
        if (p?.reason) opts.onEvent({ type: "screen_lost", reason: p.reason });
    });

    return {
        sendStatus(phase, now = Date.now()) {
            if (closed) return false;
            if (!socket.connected) {
                pending = phase;
                return false;
            }
            if (now - lastStatusAt < STATUS_MIN_INTERVAL_MS) return false;
            emitStatus(phase, now);
            return true;
        },
        close() {
            closed = true;
            socket.disconnect();
        }
    };
}
