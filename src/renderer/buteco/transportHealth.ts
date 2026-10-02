/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ScreenTransport } from "./screenTransport";

/**
 * Lembra qual transporte falhou há pouco, para a próxima transmissão tentar o
 * outro primeiro em vez de esperar de novo o timeout de um servidor que está fora.
 */
export const FAILURE_MEMORY_MS = 10 * 60 * 1000;

const lastFailure = new Map<ScreenTransport, number>();

export function recordTransportFailure(transport: ScreenTransport, now = Date.now()): void {
    lastFailure.set(transport, now);
}

export function recordTransportSuccess(transport: ScreenTransport): void {
    lastFailure.delete(transport);
}

export function resetTransportHealth(): void {
    lastFailure.clear();
}

function failedRecently(transport: ScreenTransport, now: number): boolean {
    const at = lastFailure.get(transport);
    return at !== undefined && now - at < FAILURE_MEMORY_MS;
}

/**
 * Mantém a ordem pedida, exceto que um transporte que falhou há pouco vai para o
 * fim (e só ele: se os dois falharam, a ordem original é mantida).
 */
export function orderByHealth(order: ScreenTransport[], now = Date.now()): ScreenTransport[] {
    const healthy = order.filter(transport => !failedRecently(transport, now));
    if (healthy.length === 0 || healthy.length === order.length) return order;
    return [...healthy, ...order.filter(transport => !healthy.includes(transport))];
}
