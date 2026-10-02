/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type ScreenTransport = "mediamtx" | "cloudflare";

/**
 * Ordem de tentativa para publicar a tela: primeiro o transporte que a sala
 * indica (como o site; sem indicação, Cloudflare) e, se falhar, o outro.
 */
export function screenTransportOrder(preferred: string | null | undefined): ScreenTransport[] {
    return preferred === "mediamtx" ? ["mediamtx", "cloudflare"] : ["cloudflare", "mediamtx"];
}

/**
 * Como assistir a tela de um streamer: o transporte que ELE registrou ao
 * publicar. Só `mediamtx` explícito usa o WHEP; o resto sai pelo SFU do Cloudflare.
 */
export function viewTransportFor(memberTransport: string | null | undefined): ScreenTransport {
    return memberTransport === "mediamtx" ? "mediamtx" : "cloudflare";
}
