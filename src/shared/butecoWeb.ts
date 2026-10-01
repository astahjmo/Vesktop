/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Origem fixa do site; nunca configurável pelo renderer. */
export const BUTECO_WEB_ORIGIN = "https://games.butecodosdevs.com";

/** Cookie de sessão do Better Auth usado pelo site. */
export const BUTECO_SESSION_COOKIE = "__Secure-better-auth.session_token";

export interface ButecoWebUser {
    id: string;
    displayName: string;
    avatar?: string | null;
}

export interface ButecoWebStatus {
    loggedIn: boolean;
    user: ButecoWebUser | null;
}

export interface ButecoRoomSummary {
    roomId: string;
    name: string;
    memberCount: number;
    hasPassword: boolean;
}

export type ButecoTransport = "mediamtx" | "cloudflare";

export interface ButecoRoomMember {
    userId: string;
    displayName: string;
    avatar?: string | null;
    screenId?: string | null;
    screenAudio?: boolean;
    screenTransport?: ButecoTransport;
}

export interface ButecoRoomState {
    roomId: string;
    name: string;
    ownerId?: string;
    members: ButecoRoomMember[];
    screenAudioAllowed: boolean;
    screenTransport: ButecoTransport;
}

export interface ButecoWebState {
    status: ButecoWebStatus;
    /** `null` = lobby nunca assinado; `[]` = assinado e vazio. */
    lobby: ButecoRoomSummary[] | null;
    room: ButecoRoomState | null;
    /** Última recusa de join/create a exibir; `null` = sem erro pendente. */
    joinError: string | null;
}

export type ButecoWebEvent =
    | { type: "status"; status: ButecoWebStatus }
    | { type: "lobby"; rooms: ButecoRoomSummary[] }
    | { type: "room"; room: ButecoRoomState | null }
    | { type: "room-closed"; reason?: string }
    | { type: "join-denied"; reason?: string };

/** Envelope do `BUTECO_WEB_EVENT`; nunca carrega cookie. */
export interface ButecoWebEnvelope {
    state: ButecoWebState;
    event?: ButecoWebEvent;
    /**
     * Controle opcional espelhando o envelope do helper: `"stop"` pede ao
     * renderer para derrubar o controller local (tracks/PC/virtmic) quando a
     * publicação web perde a sala (leave, closed/replaced, disconnect).
     */
    control?: "stop";
}

/** Converte o motivo de `screenshare:join_denied` numa mensagem curta em PT. */
export function mapJoinDeniedMessage(reason: unknown): string {
    switch (typeof reason === "string" ? reason.toLowerCase() : "") {
        case "password":
        case "wrong_password":
        case "invalid_password":
            return "Senha incorreta.";
        case "full":
        case "room_full":
            return "Sala cheia.";
        case "not_found":
        case "closed":
        case "unavailable":
            return "Sala indisponível.";
        default:
            return "Entrada negada.";
    }
}

export function mapLobbyRooms(raw: unknown): ButecoRoomSummary[] {
    const list = Array.isArray(raw) ? raw : (raw as any)?.rooms;
    if (!Array.isArray(list)) return [];

    return list.flatMap(item => {
        const room = item as any;
        if (typeof room?.roomId !== "string" || typeof room?.name !== "string") return [];
        return [
            {
                roomId: room.roomId,
                name: room.name,
                memberCount: typeof room.memberCount === "number" ? room.memberCount : 0,
                hasPassword: Boolean(room.hasPassword)
            }
        ];
    });
}

export function mapRoomState(raw: unknown): ButecoRoomState | null {
    const room = raw as any;
    if (!room || typeof room.roomId !== "string") return null;

    const members: ButecoRoomMember[] = Array.isArray(room.members)
        ? room.members.flatMap((member: any) =>
              typeof member?.userId === "string"
                  ? [
                        {
                            userId: member.userId,
                            displayName: typeof member.displayName === "string" ? member.displayName : member.userId,
                            avatar: member.avatar ?? null,
                            screenId: member.screenId ?? null,
                            screenAudio: Boolean(member.screenAudio),
                            screenTransport: member.screenTransport
                        }
                    ]
                  : []
          )
        : [];

    return {
        roomId: room.roomId,
        name: typeof room.name === "string" ? room.name : "Sala",
        ownerId: room.ownerId,
        members,
        screenAudioAllowed: room.screenAudioAllowed !== false,
        screenTransport: room.screenTransport === "cloudflare" ? "cloudflare" : "mediamtx"
    };
}
