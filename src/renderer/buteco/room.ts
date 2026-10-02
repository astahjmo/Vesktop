/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoResult } from "shared/buteco";

import { applyRoomOpenTimeoutMs, getButecoWebState, subscribeButecoWeb } from "./webState";

const ROOM_WORDS = ["Chopp", "Petisco", "Saideira", "Balcão", "Porção", "Gelada", "Churrasco", "Mesa", "Resenha"];

/** Nome curto e aleatório, ex.: "Saideira 4821". */
export function randomRoomName(random: () => number = Math.random): string {
    const word = ROOM_WORDS[Math.floor(random() * ROOM_WORDS.length)];
    const digits = 1000 + Math.floor(random() * 9000);
    return `${word} ${digits}`;
}

/** Sala que o próprio app criou (para sair dela quando não houver mais o que fazer). */
let autoCreatedRoomId: string | null = null;

export function getAutoCreatedRoomId(): string | null {
    return autoCreatedRoomId;
}

export function clearAutoCreatedRoom(): void {
    autoCreatedRoomId = null;
}

function hasOtherSharer(state: ReturnType<typeof getButecoWebState>): boolean {
    const selfId = state.status.user?.id;
    return Boolean(state.room?.members.some(member => member.screenId && member.userId !== selfId));
}

function failure(message: string): ButecoResult<void> {
    return { ok: false, error: { code: "network", message } };
}

/**
 * Garante que estamos numa sala. Sem sala, cria uma com nome aleatório e sem
 * senha e espera o servidor confirmar o estado dela.
 */
export async function ensureButecoRoom(options: { exclusive?: boolean } = {}): Promise<ButecoResult<void>> {
    const initial = getButecoWebState();
    const previousRoomId = initial.room?.roomId ?? null;

    // Só cabe uma tela por sala: para compartilhar numa sala onde outra pessoa já
    // transmite, saímos dela e abrimos uma sala própria.
    if (initial.room && options.exclusive && hasOtherSharer(initial)) {
        await VesktopNative.buteco.web.leaveRoom();
    } else if (initial.room) {
        return { ok: true, value: undefined };
    }

    if (!initial.status.loggedIn) {
        return { ok: false, error: { code: "token_invalid", message: "Entre no Buteco Games primeiro." } };
    }

    // Assina antes de criar: o estado da sala pode chegar antes da resposta do IPC.
    let unsubscribe = () => {};
    const opened = new Promise<ButecoResult<void>>(resolve => {
        const timer = setTimeout(
            () => resolve(failure("A sala não abriu a tempo. Tente de novo.")),
            applyRoomOpenTimeoutMs()
        );
        unsubscribe = subscribeButecoWeb(() => {
            const state = getButecoWebState();
            // O estado da sala que acabamos de deixar ainda pode chegar: ignora.
            if (state.room && state.room.roomId !== previousRoomId) {
                clearTimeout(timer);
                autoCreatedRoomId = state.room.roomId;
                resolve({ ok: true, value: undefined });
            } else if (state.joinError) {
                clearTimeout(timer);
                resolve(failure(state.joinError));
            }
        });
    });

    try {
        const created = (await VesktopNative.buteco.web.createRoom(randomRoomName(), "")) as ButecoResult<void>;
        if (!created.ok) return created;
        return await opened;
    } finally {
        unsubscribe();
    }
}

/** Sai da sala que o app criou sozinho (e só dela). */
export async function leaveAutoCreatedRoom(): Promise<void> {
    const roomId = autoCreatedRoomId;
    autoCreatedRoomId = null;
    if (roomId && getButecoWebState().room?.roomId === roomId) {
        await VesktopNative.buteco.web.leaveRoom();
    }
}
