/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoIceServer, ButecoPublishMeta, ButecoPublishResult, ButecoResult } from "shared/buteco";

import { groundRequest } from "./ground";

const BASE = "/api/compartilhagram/helper";
const BUSY_RETRY_MS = [500, 1000, 2000];

export interface WhipDeps {
    token: string;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}

export interface PublishScreenRequest extends WhipDeps {
    offerSdp: string;
    meta: ButecoPublishMeta;
    takeover?: boolean;
}

export async function publishScreen(req: PublishScreenRequest): Promise<ButecoResult<ButecoPublishResult>> {
    const sleep = req.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

    for (let attempt = 0; ; attempt++) {
        const body: Record<string, unknown> = { sdp: req.offerSdp, meta: req.meta };
        if (req.takeover !== undefined) body.takeover = req.takeover;

        const r = await groundRequest<any>(`${BASE}/screen/whip`, {
            method: "POST",
            body,
            token: req.token,
            fetchImpl: req.fetchImpl
        });

        if (r.ok) {
            if (typeof r.value?.sdp === "string" && typeof r.value?.streamId === "string") {
                return { ok: true, value: { sdp: r.value.sdp, streamId: r.value.streamId } };
            }
            return { ok: false, error: { code: "sfu_unavailable", message: "Resposta inválida do servidor." } };
        }

        const busy = r.error.code === "busy";
        if (!busy) return r;

        const delay = BUSY_RETRY_MS[attempt];
        if (delay === undefined) {
            return { ok: false, error: { code: "sfu_unavailable", message: "SFU indisponível." } };
        }
        const hinted = r.error.retryAfterSec;
        await sleep(hinted !== undefined ? Math.min(delay, hinted * 1000) : delay);
    }
}

export function unpublishScreen(deps: WhipDeps): Promise<ButecoResult<void>> {
    return groundRequest<void>(`${BASE}/screen`, { method: "DELETE", token: deps.token, fetchImpl: deps.fetchImpl });
}

export function refreshIce(deps: WhipDeps): Promise<ButecoResult<ButecoIceServer[]>> {
    return groundRequest<{ iceServers: ButecoIceServer[] }>(`${BASE}/ice`, {
        method: "GET",
        token: deps.token,
        fetchImpl: deps.fetchImpl
    }).then(r =>
        r.ok && Array.isArray(r.value?.iceServers)
            ? ({ ok: true, value: r.value.iceServers } as const)
            : ({ ok: false, error: { code: "network", message: "Resposta inválida do servidor." } } as const)
    );
}

export function unpair(deps: WhipDeps): Promise<ButecoResult<void>> {
    return groundRequest<void>(`${BASE}/pairing`, { method: "DELETE", token: deps.token, fetchImpl: deps.fetchImpl });
}
