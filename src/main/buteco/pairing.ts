/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BUTECO_PROTOCOL, type ButecoResult, type ButecoSession } from "shared/buteco";

import { groundRequest } from "./ground";

const EXCHANGE_PATH = "/api/compartilhagram/pairing/exchange";

/** Uppercases and strips separators; returns null for obviously invalid codes. */
export function normalizePairingCode(raw: string): string | null {
    const code = raw.replace(/[\s-]/g, "").toUpperCase();
    if (!code || !/^[A-Z0-9]+$/.test(code)) return null;
    return code;
}

export interface ButecoClientInfo {
    app: "buteco-share";
    version: string;
    os: string;
    osVersion: string;
    protocol: typeof BUTECO_PROTOCOL;
    capabilities: { appAudio: false; mic: true; maxHeight: 1440; maxFps: 60 };
}

/**
 * Resolves the version to advertise to the Ground.
 *
 * Prefers the real Vesktop app version from Electron's `app`. The `require` is
 * lazy so the module still loads under the vitest node environment (where
 * `electron` is not a usable API); when unavailable it falls back to the
 * Electron/Node version reported by `process.versions`.
 */
export function appVersion(): string {
    try {
        const { app } = require("electron");
        if (app?.getVersion) return app.getVersion();
    } catch {}
    return process.versions.electron ?? process.versions.node;
}

/**
 * Describes the helper client to the Ground.
 *
 * The client version is injectable so tests can pin it; the production default
 * resolves through `appVersion()`, keeping `exchangeCode(code)` correct without
 * changing its call contract.
 */
export function clientInfo(version = appVersion()): ButecoClientInfo {
    return {
        app: "buteco-share",
        version,
        os: process.platform,
        osVersion: process.getSystemVersion?.() ?? "",
        protocol: BUTECO_PROTOCOL,
        capabilities: { appAudio: false, mic: true, maxHeight: 1440, maxFps: 60 }
    };
}

export async function exchangeCode(
    rawCode: string,
    fetchImpl?: typeof fetch,
    client: ButecoClientInfo = clientInfo()
): Promise<ButecoResult<ButecoSession>> {
    const code = normalizePairingCode(rawCode);
    if (!code) {
        return { ok: false, error: { code: "invalid_code_format", message: "Código de pareamento inválido." } };
    }
    return groundRequest<ButecoSession>(EXCHANGE_PATH, {
        method: "POST",
        body: { code, client },
        fetchImpl
    });
}

export interface TokenVault {
    set(session: ButecoSession): void;
    getToken(now?: number): string | null;
    getSession(): ButecoSession | null;
    clear(): void;
}

export function createTokenVault(): TokenVault {
    let session: ButecoSession | null = null;
    let expiresAt: number | null = null;

    return {
        set(value) {
            session = value;
            const t = Date.parse(value.tokenExpiresAt);
            expiresAt = Number.isFinite(t) ? t : null;
        },
        getToken(now = Date.now()) {
            if (session && expiresAt !== null && now >= expiresAt) session = null;
            return session?.token ?? null;
        },
        getSession() {
            return session;
        },
        clear() {
            session = null;
            expiresAt = null;
        }
    };
}

export const tokenVault = createTokenVault();
