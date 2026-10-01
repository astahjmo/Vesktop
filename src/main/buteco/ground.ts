/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BUTECO_APP_BASE, BUTECO_REQUEST_TIMEOUT_MS, type ButecoResult, mapGroundRefusal } from "shared/buteco";

export interface GroundRequestOptions {
    method: "GET" | "POST" | "DELETE";
    body?: unknown;
    token?: string;
    fetchImpl?: typeof fetch;
}

/** Performs an authenticated request against the Buteco Ground. */
export async function groundRequest<T = any>(path: string, opts: GroundRequestOptions): Promise<ButecoResult<T>> {
    const doFetch = opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;

    let res: Response;
    try {
        res = await doFetch(`${BUTECO_APP_BASE}${path}`, {
            method: opts.method,
            headers,
            ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
            signal: AbortSignal.timeout(BUTECO_REQUEST_TIMEOUT_MS)
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
