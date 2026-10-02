/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoError, ButecoResult } from "shared/buteco";

import type { StartOptions } from "./controller";
import { ensureSfu, getSfuSession, subscribeSfuBroken } from "./sfu";
import { screenPreset } from "./sfuPresets";
import type { SfuSession } from "./sfuSession";
import { SfuError } from "./sfuUtil";

/**
 * Publicar a tela pelo SFU do Cloudflare (o mesmo caminho do site): a captura
 * entra no slot de tela da sessão e `screen {on:true}` registra a tela na sala.
 * É só vídeo: o áudio de app/microfone só existe no caminho do MediaMTX.
 */

/** Tempo máximo esperando a mídia da sessão conectar antes de desistir. */
const MEDIA_CONNECT_TIMEOUT_MS = 12_000;
const BUSY_RETRIES = 2;
const BUSY_RETRY_MS = 300;

let localScreen: MediaStream | null = null;
let active = false;
const listeners = new Set<() => void>();

/** Stream da tela local (para o self-view, já que o SFU não devolve o próprio stream). */
export function getLocalScreenStream(): MediaStream | null {
    return active ? localScreen : null;
}

export function isCloudflareScreenActive(): boolean {
    return active;
}

export function subscribeLocalScreen(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function notify() {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            // um assinante quebrado não bloqueia os outros
        }
    }
}

function toButecoError(error: unknown): ButecoError {
    const message = String((error as Error)?.message ?? error);
    const reason = (error as SfuError)?.reason ?? "";

    // 409 do servidor: já existe uma tela ativa na sala.
    if (/taken|HTTP 409|screen_taken/i.test(`${reason} ${message}`)) {
        return { code: "screen_taken", message };
    }
    if (reason === "no_media") return { code: "sfu_unavailable", message };
    return { code: "sfu_unavailable", message };
}

async function setServerScreen(session: SfuSession, on: boolean) {
    for (let attempt = 0; ; attempt++) {
        try {
            await session.setServerScreen(on);
            return;
        } catch (error) {
            // `busy`: o servidor ainda fecha a renegociação anterior; tenta de novo.
            if ((error as SfuError).reason === "busy" && attempt < BUSY_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, BUSY_RETRY_MS));
                continue;
            }
            throw error;
        }
    }
}

export async function startCloudflareScreen(track: MediaStreamTrack, opts: StartOptions): Promise<ButecoResult<void>> {
    let session: SfuSession | null = null;
    try {
        session = await ensureSfu();

        // Sem mídia conectada o servidor registraria a tela sem receber nada.
        if (!(await session.waitForMedia(MEDIA_CONNECT_TIMEOUT_MS))) {
            throw new SfuError("Sem conexão com o servidor de mídia (Cloudflare).", "no_media");
        }

        await session.setScreenTrack(track);
        await session.applyScreenPreset(screenPreset(opts.height, opts.fps));
        await setServerScreen(session, true);

        localScreen = new MediaStream([track]);
        active = true;
        notify();
        return { ok: true, value: undefined };
    } catch (error) {
        await session?.setScreenTrack(null).catch(() => {});
        return { ok: false, error: toButecoError(error) };
    }
}

export async function stopCloudflareScreen(): Promise<void> {
    const session = getSfuSession();
    const wasActive = active;
    active = false;
    localScreen = null;
    if (wasActive) notify();

    if (!session) return;
    await session.setScreenTrack(null).catch(() => {});
    // Libera a vaga de tela no servidor (e responde a renegociação que ele pede).
    if (wasActive) await session.setServerScreen(false).catch(() => {});
}

// A sessão caiu por conta própria enquanto transmitíamos: a tela deixou de existir.
subscribeSfuBroken(() => {
    if (!active) return;
    active = false;
    localScreen = null;
    notify();
    void import("../components/ScreenSharePicker").then(module => module.stopActiveButeco());
});
