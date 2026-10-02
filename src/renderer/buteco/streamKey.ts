/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Chave de stream no formato que o Discord parseia: `guild:<guildId>:<channelId>:<ownerId>`
 * ou `call:<channelId>:<ownerId>` (DM). Outro formato quebra o player nativo.
 */
export function discordStreamKey(guildId: string | null | undefined, channelId: string, ownerId: string): string {
    return guildId ? `guild:${guildId}:${channelId}:${ownerId}` : `call:${channelId}:${ownerId}`;
}
