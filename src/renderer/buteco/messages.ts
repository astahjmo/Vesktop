/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoErrorCode } from "shared/buteco";

/**
 * Human-readable messages for every `ButecoErrorCode`. The `Record` annotation
 * makes the map exhaustive at compile time: adding a code to
 * `KNOWN_ERROR_CODES` without a message here is a type error.
 */
export const BUTECO_ERROR_MESSAGES: Record<ButecoErrorCode, string> = {
    invalid_code_format: "Código de pareamento inválido.",
    token_invalid: "Sessão expirada. Faça login novamente.",
    client_outdated: "Atualize o Buteco Games para continuar.",
    network: "Falha de rede. Tente novamente.",
    unsupported: "Recurso não suportado.",
    permission_denied: "Captura de tela não autorizada.",
    video_capture_failed: "Não foi possível capturar a fonte escolhida.",
    screen_audio_disabled: "O áudio da tela está desativado na sala.",
    screen_taken: "Alguém já está compartilhando a tela.",
    screen_taken_self: "Você já está compartilhando pelo navegador.",
    sfu_unavailable: "Servidor de mídia indisponível. Tente novamente.",
    device_error: "Erro no dispositivo de áudio.",
    busy: "Servidor ocupado. Tentando novamente..."
};

/**
 * Codes that mean the stored session can no longer be used and the user has to
 * pair again before anything else works. Accepts `undefined` so callers can pass
 * an optional error's code directly.
 */
export function isRepairErrorCode(code: ButecoErrorCode | undefined): boolean {
    return code === "token_invalid" || code === "client_outdated";
}
