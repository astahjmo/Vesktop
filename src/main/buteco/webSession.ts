/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, session } from "electron";
import { BUTECO_SESSION_COOKIE, BUTECO_WEB_ORIGIN, type ButecoWebStatus, type ButecoWebUser } from "shared/butecoWeb";

const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_POLL_MS = 1000;

export function cookieHeaderFrom(cookies: Array<{ name: string; value: string }>): string | null {
    const found = cookies.find(cookie => cookie.name === BUTECO_SESSION_COOKIE);
    return found ? `${found.name}=${found.value}` : null;
}

/** Lê o cookie de sessão do site na sessão padrão do app. Nunca loga o valor. */
export async function getWebCookieHeader(): Promise<string | null> {
    const cookies = await session.defaultSession.cookies.get({ url: BUTECO_WEB_ORIGIN });
    return cookieHeaderFrom(cookies);
}

export function parseSessionUser(body: unknown): ButecoWebUser | null {
    const user = (body as any)?.user;
    if (!user || typeof user.id !== "string") return null;
    return {
        id: user.id,
        displayName: typeof user.name === "string" && user.name ? user.name : user.id,
        avatar: user.image ?? null
    };
}

/** Parte pura do status: cookie + fetch são injetáveis para teste. */
export async function getWebStatusFrom(
    cookie: string | null,
    fetchImpl: typeof fetch = fetch
): Promise<ButecoWebStatus> {
    if (!cookie) return { loggedIn: false, user: null };

    try {
        const res = await fetchImpl(`${BUTECO_WEB_ORIGIN}/api/auth/get-session`, {
            headers: { cookie, accept: "application/json" },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!res.ok) return { loggedIn: false, user: null };
        return { loggedIn: true, user: parseSessionUser(await res.json().catch(() => null)) };
    } catch {
        // Cookie presente mas endpoint fora do ar: segue logado sem nome.
        return { loggedIn: true, user: null };
    }
}

export async function getWebStatus(): Promise<ButecoWebStatus> {
    return getWebStatusFrom(await getWebCookieHeader());
}

/**
 * Abre a janela de login no site usando a sessão padrão (o OAuth do Discord
 * reaproveita o login do app) e resolve quando o cookie de sessão aparece ou a
 * janela fecha.
 */
export function openWebLoginWindow(): Promise<ButecoWebStatus> {
    return new Promise(resolve => {
        const win = new BrowserWindow({
            width: 1000,
            height: 720,
            autoHideMenuBar: true,
            title: "Entrar no Buteco Games",
            webPreferences: { contextIsolation: true, nodeIntegration: false }
        });

        void win.loadURL(`${BUTECO_WEB_ORIGIN}/login`);

        let settled = false;
        const timer = setInterval(async () => {
            if (win.isDestroyed()) return finish();
            if (await getWebCookieHeader()) {
                win.close();
                void finish();
            }
        }, LOGIN_POLL_MS);

        async function finish() {
            if (settled) return;
            settled = true;
            clearInterval(timer);
            resolve(await getWebStatus());
        }

        win.on("closed", () => void finish());
    });
}
