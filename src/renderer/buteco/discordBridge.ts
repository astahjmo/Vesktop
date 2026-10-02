/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByProps } from "@vencord/types/webpack";
import { UserStore } from "@vencord/types/webpack/common";

import { getButecoWebState } from "./webState";

/** Canal de voz atual do Discord (e o servidor dele, quando houver). */
export function getVoiceChannel(): { channelId: string; guildId: string | null } | null {
    const selected = findByProps("getVoiceChannelId");
    const channelId = selected?.getVoiceChannelId?.();
    if (!channelId) return null;

    const channelStore = findByProps("getChannel", "getDMFromUserId");
    const guildId = channelStore?.getChannel?.(channelId)?.guild_id ?? null;
    return { channelId, guildId };
}

/**
 * A sala do Buteco usa os ids do SITE (Better Auth), não os do Discord.
 * - Para nós mesmos: comparamos com o id do usuário logado no site.
 * - Para os outros: casamos o displayName com os membros da call (username,
 *   globalName ou nick), que é a única ponte disponível no payload. Primeiro
 *   por igualdade; depois ignorando símbolos/emoji, só se o resultado for único.
 */
export function resolveDiscordUserId(
    siteId: string,
    displayName: string,
    note: (message: string) => void = () => {}
): string | null {
    const self = UserStore.getCurrentUser();
    if (self && siteId === getButecoWebState().status.user?.id) return self.id;

    const channel = getVoiceChannel();
    if (!channel) return null;

    const channelStore = findByProps("getChannel", "getDMFromUserId");
    const voiceStates = findByProps("getVoiceStatesForChannel");
    const channelObject = channelStore?.getChannel?.(channel.channelId);
    const entries = (channelObject ? voiceStates?.getVoiceStatesForChannel?.(channelObject) : null) as
        Array<{ voiceState?: { userId?: string }; nick?: string | null }> | null | undefined;
    if (!entries?.length) return null;

    const candidates = entries
        .map(entry => {
            const userId = entry.voiceState?.userId;
            const user = userId ? (UserStore.getUser(userId) as any) : null;
            return userId && user ? { userId, names: [user.username, user.globalName, entry.nick] } : null;
        })
        .filter((candidate): candidate is { userId: string; names: Array<string | null | undefined> } => !!candidate);

    const exact = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();
    const loose = (value: string | null | undefined) => (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

    for (const [normalize, label] of [
        [exact, "exato"],
        [loose, "aproximado"]
    ] as const) {
        const target = normalize(displayName);
        if (!target) continue;
        const matches = candidates.filter(candidate => candidate.names.some(name => normalize(name) === target));
        if (matches.length === 1) return matches[0].userId;
        if (matches.length > 1) {
            note(`nome ambíguo (${label}): "${displayName}" casa com ${matches.length} membros da call`);
            return null;
        }
    }

    // Quem compartilha pode simplesmente não estar nesta call: não é erro.
    return null;
}
