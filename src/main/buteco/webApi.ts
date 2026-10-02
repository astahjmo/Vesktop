/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type ButecoIceServer, type ButecoResult, mapGroundRefusal } from "shared/buteco";
import { BUTECO_WEB_ORIGIN, type ButecoSfuOp } from "shared/butecoWeb";

import { getWebCookieHeader } from "./webSession";

export const WEB_REQUEST_TIMEOUT_MS = 15_000;

export interface WebRequestOptions {
    method: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    /** `undefined` = lê do cofre de sessão (produção); `null` = sem cookie. */
    cookieHeader?: string | null;
    fetchImpl?: typeof fetch;
}

/** Request autenticada por cookie contra o site. Nunca loga headers. */
export async function webRequest<T = any>(path: string, opts: WebRequestOptions): Promise<ButecoResult<T>> {
    const doFetch = opts.fetchImpl ?? fetch;

    let cookie: string | null;
    try {
        cookie = opts.cookieHeader !== undefined ? opts.cookieHeader : await getWebCookieHeader();
    } catch {
        // Ler o cofre de cookies pode rejeitar (ex.: sessão indisponível); a
        // chamada nunca deve explodir para o handler IPC.
        return { ok: false, error: { code: "network", message: "Falha de rede." } };
    }
    if (!cookie) return { ok: false, error: { code: "token_invalid", message: "Entre no Buteco Games primeiro." } };

    // Origin/Referer da própria origem do site: mesma defesa de CSRF que o
    // navegador manda e que o socket já exige no handshake.
    const headers: Record<string, string> = {
        accept: "application/json",
        cookie,
        origin: BUTECO_WEB_ORIGIN,
        referer: `${BUTECO_WEB_ORIGIN}/`
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
        res = await doFetch(`${BUTECO_WEB_ORIGIN}${path}`, {
            method: opts.method,
            headers,
            ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
            signal: AbortSignal.timeout(WEB_REQUEST_TIMEOUT_MS)
        });
    } catch {
        return { ok: false, error: { code: "network", message: "Falha de rede." } };
    }

    const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    if (!res.ok) {
        return { ok: false, error: mapGroundRefusal(res.status, body, res.headers.get("retry-after")) };
    }
    return { ok: true, value: body as T };
}

export type WebApiDeps = Pick<WebRequestOptions, "cookieHeader" | "fetchImpl">;

export async function fetchWebIce(deps: WebApiDeps = {}): Promise<ButecoResult<ButecoIceServer[]>> {
    const res = await webRequest<{ iceServers: ButecoIceServer[] }>("/api/rtc/ice?purpose=screenshare", {
        method: "GET",
        ...deps
    });
    if (!res.ok) return res;
    return Array.isArray(res.value?.iceServers)
        ? { ok: true, value: res.value.iceServers }
        : { ok: false, error: { code: "network", message: "Resposta inválida do servidor." } };
}

export function webPublishScreen(
    roomId: string,
    socketId: string,
    sdp: string,
    deps: WebApiDeps = {}
): Promise<ButecoResult<{ sdp: string }>> {
    return webRequest("/api/compartilhagram/sfu/screen/whip", {
        method: "POST",
        body: { roomId, socketId, sdp },
        ...deps
    });
}

/** Assiste a tela publicada na sala (WHEP): oferta do viewer → answer do SFU. */
export function webSubscribeScreen(
    roomId: string,
    socketId: string,
    sdp: string,
    deps: WebApiDeps = {}
): Promise<ButecoResult<{ sdp: string }>> {
    return webRequest("/api/compartilhagram/sfu/screen/whep", {
        method: "POST",
        body: { roomId, socketId, sdp },
        ...deps
    });
}

/** Solta a vaga de tela no SFU (`on:false`); usado no stop e em retries. */
export function webReleaseScreen(roomId: string, socketId: string, deps: WebApiDeps = {}): Promise<ButecoResult<void>> {
    return webRequest("/api/compartilhagram/sfu/screen", {
        method: "POST",
        body: { roomId, socketId, on: false },
        ...deps
    });
}

/** Best-effort: fecha a mídia da sessão no SFU. */
export function webCloseConnection(
    roomId: string,
    socketId: string,
    deps: WebApiDeps = {}
): Promise<ButecoResult<void>> {
    return webRequest("/api/compartilhagram/sfu/close", {
        method: "POST",
        body: { roomId, socketId },
        ...deps
    });
}

const SFU_ROUTES: Record<ButecoSfuOp, { method: "POST" | "PUT"; path: string; fields: readonly string[] }> = {
    connect: { method: "POST", path: "/api/compartilhagram/sfu/connect", fields: ["sdp", "mids"] },
    camera: { method: "POST", path: "/api/compartilhagram/sfu/camera", fields: ["on"] },
    pull: { method: "POST", path: "/api/compartilhagram/sfu/pull", fields: ["targets"] },
    renegotiate: { method: "PUT", path: "/api/compartilhagram/sfu/renegotiate", fields: ["sdp"] },
    layer: { method: "PUT", path: "/api/compartilhagram/sfu/layer", fields: ["updates"] },
    close: { method: "POST", path: "/api/compartilhagram/sfu/close", fields: [] }
};

/**
 * Operação do SFU de câmera. Só rotas e campos de uma lista fixa; o corpo
 * sempre leva o roomId/socketId da sessão do processo principal.
 */
export function webSfu(
    op: ButecoSfuOp,
    roomId: string,
    socketId: string,
    payload: Record<string, unknown> | undefined,
    deps: WebApiDeps = {}
): Promise<ButecoResult<any>> {
    const route = Object.hasOwn(SFU_ROUTES, op) ? SFU_ROUTES[op] : undefined;
    if (!route) {
        return Promise.resolve({ ok: false, error: { code: "network", message: "Operação inválida." } });
    }

    const body: Record<string, unknown> = { roomId, socketId };
    for (const field of route.fields) {
        if (payload?.[field] !== undefined) body[field] = payload[field];
    }
    return webRequest(route.path, { method: route.method, body, ...deps });
}
