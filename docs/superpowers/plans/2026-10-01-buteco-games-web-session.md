# Buteco Games Web — Sessão, Salas e Transmissão sem Código (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trocar o pairing code do Buteco Games por uma sessão web única (login no site), com lobby de salas e publicação de tela via WHIP do site — tudo sem código.

**Architecture:** O `main` faz toda a rede (cookies de sessão, Socket.IO, ICE/WHIP) e o renderer faz o WebRTC, mesmo padrão do módulo helper atual. Uma sessão persistente (janela de login na sessão padrão) alimenta socket e HTTP; o estado (status/lobby/sala) vai ao renderer por um envelope novo `BUTECO_WEB_EVENT`.

**Tech Stack:** Electron 44, TypeScript, socket.io-client 4.8, React 19 (via `@vencord/types`), vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-buteco-games-web-session-design.md`

## Global Constraints

- **Sem mudanças no backend do Buteco.** Só consumimos os endpoints existentes.
- **Cookie de sessão nunca cruza o IPC.** Só o `main` lê `session.defaultSession.cookies`.
- **IPC só com `handle`/`handleSync`** de `src/main/utils/ipcWrappers.ts`.
- **Estilo:** 4 espaços, double quotes, header GPL-3.0 em todo arquivo.
- **`pnpm test` já é `lint && testTypes`**; testes unitários são `pnpm test:unit`.
- **Nada de logar cookie/segredo.** Headers com `cookie` nunca são impressos.
- **Timeout de requisição web:** `AbortSignal.timeout(15_000)`.
- **Origem fixa:** `https://games.butecodosdevs.com` (`BUTECO_WEB_ORIGIN`).
- **Preservar** o módulo helper de pairing existente (`pairing/socket/whip`), mesmo sem UI.

---

## File Structure

**Criar:**
- `src/shared/butecoWeb.ts` — tipos (`ButecoWebState`, `ButecoWebEvent`, salas) e mappers puros.
- `src/main/buteco/webSession.ts` — cookie da sessão, janela de login, status.
- `src/main/buteco/webApi.ts` — ICE/WHIP/WHEP/release/close com cookie.
- `src/main/buteco/roomSocket.ts` — Socket.IO do site com cookie.
- `src/main/buteco/webStore.ts` — estado web + eventos.
- `src/main/buteco/web.ts` — `registerButecoWeb()` e handlers IPC.
- `src/renderer/buteco/webState.ts` — store puro do renderer.
- `src/renderer/buteco/useButecoWeb.ts` — hook + assinatura do envelope.
- Testes: `src/shared/butecoWeb.test.ts`, `src/main/buteco/{webSession,webApi,roomSocket,webStore}.test.ts`, `src/renderer/buteco/webState.test.ts`.

**Modificar:**
- `src/shared/IpcEvents.ts` — novos eventos `BUTECO_WEB_*` / `BUTECO_ROOM_*`.
- `src/preload/VesktopNative.ts` — `VesktopNative.buteco.web.*`.
- `src/main/main.ts` — chamar `registerButecoWeb()`.
- `src/renderer/buteco/ButecoPanel.tsx` — estados de sessão/lobby/sala.
- `src/renderer/buteco/VoicePanelButton.tsx` — remove pairing do modal.
- `src/renderer/components/ScreenSharePicker.tsx` — `startButecoPublish` via web; props do painel.

---

### Task 1: Shared web types + mappers

**Files:**
- Create: `src/shared/butecoWeb.ts`
- Test: `src/shared/butecoWeb.test.ts`

**Interfaces:**
- Consumes: `ButecoIceServer` de `shared/buteco` (só tipo).
- Produces: `BUTECO_WEB_ORIGIN`, `BUTECO_SESSION_COOKIE`, `ButecoWebUser`, `ButecoWebStatus`, `ButecoRoomSummary`, `ButecoRoomMember`, `ButecoRoomState`, `ButecoWebState`, `ButecoWebEvent`, `ButecoWebEnvelope`, `mapLobbyRooms(raw)`, `mapRoomState(raw)`.

- [ ] **Step 1: Write the failing test**

Crie `src/shared/butecoWeb.test.ts`:

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { mapLobbyRooms, mapRoomState } from "./butecoWeb";

describe("mapLobbyRooms", () => {
    it("maps a room array and tolerates missing fields", () => {
        const rooms = mapLobbyRooms([
            { roomId: "r1", name: "Mesa", memberCount: 3, hasPassword: true },
            { roomId: "r2", name: "Outra" },
            { nope: true },
            null
        ]);
        expect(rooms).toEqual([
            { roomId: "r1", name: "Mesa", memberCount: 3, hasPassword: true },
            { roomId: "r2", name: "Outra", memberCount: 0, hasPassword: false }
        ]);
    });

    it("accepts a { rooms } wrapper and rejects garbage", () => {
        expect(mapLobbyRooms({ rooms: [{ roomId: "r1", name: "Mesa" }] })).toHaveLength(1);
        expect(mapLobbyRooms(undefined)).toEqual([]);
        expect(mapLobbyRooms("lol")).toEqual([]);
    });
});

describe("mapRoomState", () => {
    it("maps members and defaults", () => {
        const room = mapRoomState({
            roomId: "r1",
            name: "Mesa",
            members: [
                { userId: "u1", displayName: "Ana", screenId: "s1", screenAudio: true, screenTransport: "mediamtx" },
                { userId: "u2" }
            ]
        });
        expect(room).not.toBeNull();
        expect(room!.name).toBe("Mesa");
        expect(room!.members).toHaveLength(2);
        expect(room!.members[0]).toMatchObject({ userId: "u1", displayName: "Ana", screenId: "s1", screenAudio: true });
        expect(room!.members[1]).toMatchObject({ userId: "u2", displayName: "u2", screenId: null, screenAudio: false });
        expect(room!.screenAudioAllowed).toBe(true);
        expect(room!.screenTransport).toBe("mediamtx");
    });

    it("returns null without a roomId and tolerates bad members", () => {
        expect(mapRoomState({ members: [] })).toBeNull();
        expect(mapRoomState(null)).toBeNull();
        const room = mapRoomState({ roomId: "r1", members: [{ foo: 1 }] });
        expect(room!.members).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit src/shared/butecoWeb.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implement `src/shared/butecoWeb.ts`**

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoIceServer } from "./buteco";

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

/** Reexport para consumidores que montam sessões sintéticas do controller. */
export type { ButecoIceServer };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit src/shared/butecoWeb.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add src/shared/butecoWeb.ts src/shared/butecoWeb.test.ts
git commit -m "feat(buteco-web): shared session/room types and mappers"
```

---

### Task 2: Main — webSession (cookie + login + status)

**Files:**
- Create: `src/main/buteco/webSession.ts`
- Test: `src/main/buteco/webSession.test.ts`

**Interfaces:**
- Consumes: `BUTECO_SESSION_COOKIE`, `BUTECO_WEB_ORIGIN`, `ButecoWebStatus`, `ButecoWebUser` (Task 1).
- Produces: `cookieHeaderFrom(cookies)`, `getWebCookieHeader()`, `parseSessionUser(body)`, `getWebStatusFrom(cookie, fetchImpl?)`, `getWebStatus()`, `openWebLoginWindow()`.

- [ ] **Step 1: Write the failing test**

Crie `src/main/buteco/webSession.test.ts`:

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { cookieHeaderFrom, getWebStatusFrom, parseSessionUser } from "./webSession";

describe("cookieHeaderFrom", () => {
    it("extracts only the session cookie", () => {
        const header = cookieHeaderFrom([
            { name: "other", value: "x" },
            { name: "__Secure-better-auth.session_token", value: "tok" }
        ]);
        expect(header).toBe("__Secure-better-auth.session_token=tok");
    });

    it("returns null without the session cookie", () => {
        expect(cookieHeaderFrom([])).toBeNull();
        expect(cookieHeaderFrom([{ name: "a", value: "b" }])).toBeNull();
    });
});

describe("parseSessionUser", () => {
    it("maps the better-auth user", () => {
        expect(parseSessionUser({ user: { id: "u1", name: "Ana", image: "http://a" } })).toEqual({
            id: "u1",
            displayName: "Ana",
            avatar: "http://a"
        });
    });

    it("returns null on malformed bodies", () => {
        expect(parseSessionUser(null)).toBeNull();
        expect(parseSessionUser({})).toBeNull();
        expect(parseSessionUser({ user: {} })).toBeNull();
    });
});

describe("getWebStatusFrom", () => {
    it("is logged out without a cookie", async () => {
        const fetchImpl = vi.fn() as unknown as typeof fetch;
        expect(await getWebStatusFrom(null, fetchImpl)).toEqual({ loggedIn: false, user: null });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("returns the user when the session endpoint answers", async () => {
        const fetchImpl = vi.fn(
            async () => new Response(JSON.stringify({ user: { id: "u1", name: "Ana" } }), { status: 200 })
        ) as unknown as typeof fetch;
        const status = await getWebStatusFrom("cookie=1", fetchImpl);
        expect(status).toEqual({ loggedIn: true, user: { id: "u1", displayName: "Ana", avatar: null } });
        const [url, init] = (fetchImpl as any).mock.calls[0];
        expect(url).toBe("https://games.butecodosdevs.com/api/auth/get-session");
        expect((init.headers as any).cookie).toBe("cookie=1");
    });

    it("stays logged in without a user when the endpoint fails", async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error("down");
        }) as unknown as typeof fetch;
        expect(await getWebStatusFrom("cookie=1", fetchImpl)).toEqual({ loggedIn: true, user: null });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit src/main/buteco/webSession.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implement `src/main/buteco/webSession.ts`**

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, session } from "electron";
import { BUTECO_SESSION_COOKIE, BUTECO_WEB_ORIGIN, type ButecoWebStatus, type ButecoWebUser } from "shared/butecoWeb";

const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_POLL_MS = 1000;

export function cookieHeaderFrom(cookies: Array<{ name: string; value: string }>): string | null {
    const found = cookies.find(cookie => cookie.name === BUTECO_SESSION_COOKIE);
    return found ? `${found.name}=${found.value}` : null;
}

/** Lê o cookie de sessão do site na sessão padrão do app. Nunca loga o valor. */
export async function getWebCookieHeader(): Promise<string | null> {
    const cookies = await session.defaultSession.cookies.get({ url: BUTECO_WEB_ORIGIN });
    return cookieHeaderFrom(cookies);
}

export function parseSessionUser(body: unknown): ButecoWebUser | null {
    const user = (body as any)?.user;
    if (!user || typeof user.id !== "string") return null;
    return {
        id: user.id,
        displayName: typeof user.name === "string" && user.name ? user.name : user.id,
        avatar: user.image ?? null
    };
}

/** Parte pura do status: cookie + fetch são injetáveis para teste. */
export async function getWebStatusFrom(
    cookie: string | null,
    fetchImpl: typeof fetch = fetch
): Promise<ButecoWebStatus> {
    if (!cookie) return { loggedIn: false, user: null };

    try {
        const res = await fetchImpl(`${BUTECO_WEB_ORIGIN}/api/auth/get-session`, {
            headers: { cookie, accept: "application/json" },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!res.ok) return { loggedIn: false, user: null };
        return { loggedIn: true, user: parseSessionUser(await res.json().catch(() => null)) };
    } catch {
        // Cookie presente mas endpoint fora do ar: segue logado sem nome.
        return { loggedIn: true, user: null };
    }
}

export async function getWebStatus(): Promise<ButecoWebStatus> {
    return getWebStatusFrom(await getWebCookieHeader());
}

/**
 * Abre a janela de login no site usando a sessão padrão (o OAuth do Discord
 * reaproveita o login do app) e resolve quando o cookie de sessão aparece ou a
 * janela fecha.
 */
export function openWebLoginWindow(): Promise<ButecoWebStatus> {
    return new Promise(resolve => {
        const win = new BrowserWindow({
            width: 1000,
            height: 720,
            autoHideMenuBar: true,
            title: "Entrar no Buteco Games",
            webPreferences: { contextIsolation: true, nodeIntegration: false }
        });

        void win.loadURL(`${BUTECO_WEB_ORIGIN}/login`);

        let settled = false;
        const timer = setInterval(async () => {
            if (win.isDestroyed()) return finish();
            if (await getWebCookieHeader()) {
                win.close();
                void finish();
            }
        }, LOGIN_POLL_MS);

        async function finish() {
            if (settled) return;
            settled = true;
            clearInterval(timer);
            resolve(await getWebStatus());
        }

        win.on("closed", () => void finish());
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit src/main/buteco/webSession.test.ts`
Expected: PASS (7 testes).

- [ ] **Step 5: Commit**

```bash
git add src/main/buteco/webSession.ts src/main/buteco/webSession.test.ts
git commit -m "feat(buteco-web): session cookie, login window and status"
```

---

### Task 3: Main — webApi (ICE/WHIP/WHEP/release/close)

**Files:**
- Create: `src/main/buteco/webApi.ts`
- Test: `src/main/buteco/webApi.test.ts`

**Interfaces:**
- Consumes: `mapGroundRefusal`, `ButecoIceServer`, `ButecoResult` (shared/buteco); `BUTECO_WEB_ORIGIN` (Task 1); `getWebCookieHeader` (Task 2).
- Produces: `webRequest<T>(path, opts)`, `fetchWebIce(deps?)`, `webPublishScreen(roomId, socketId, sdp, deps?)`, `webReleaseScreen(roomId, socketId, deps?)`, `webCloseConnection(roomId, socketId, deps?)`.

- [ ] **Step 1: Write the failing test**

Crie `src/main/buteco/webApi.test.ts`:

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { fetchWebIce, webPublishScreen, webReleaseScreen, webRequest } from "./webApi";

function fakeFetch(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("webRequest", () => {
    it("sends the cookie header and parses JSON", async () => {
        const fetchImpl = fakeFetch(200, { ok: 1 });
        const res = await webRequest<{ ok: number }>("/api/x", { method: "POST", body: { a: 1 }, cookieHeader: "c=1", fetchImpl });
        expect(res).toEqual({ ok: true, value: { ok: 1 } });
        const [url, init] = (fetchImpl as any).mock.calls[0];
        expect(url).toBe("https://games.butecodosdevs.com/api/x");
        expect((init.headers as any).cookie).toBe("c=1");
        expect(init.body).toBe(JSON.stringify({ a: 1 }));
    });

    it("fails fast without a cookie", async () => {
        const fetchImpl = vi.fn() as unknown as typeof fetch;
        const res = await webRequest("/api/x", { method: "GET", cookieHeader: null, fetchImpl });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("token_invalid");
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("maps a 401 to token_invalid", async () => {
        const res = await webRequest("/api/x", { method: "GET", cookieHeader: "c=1", fetchImpl: fakeFetch(401, {}) });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("token_invalid");
    });
});

describe("web endpoints", () => {
    it("fetches ICE servers", async () => {
        const fetchImpl = fakeFetch(200, { iceServers: [{ urls: "stun:x" }] });
        const res = await fetchWebIce({ cookieHeader: "c=1", fetchImpl });
        expect(res).toEqual({ ok: true, value: [{ urls: "stun:x" }] });
        expect((fetchImpl as any).mock.calls[0][0]).toBe("https://games.butecodosdevs.com/api/rtc/ice?purpose=screenshare");
    });

    it("publishes via WHIP with roomId/socketId/sdp", async () => {
        const fetchImpl = fakeFetch(200, { sdp: "v=0 answer" });
        const res = await webPublishScreen("r1", "s1", "v=0 offer", { cookieHeader: "c=1", fetchImpl });
        expect(res).toEqual({ ok: true, value: { sdp: "v=0 answer" } });
        const [url, init] = (fetchImpl as any).mock.calls[0];
        expect(url).toBe("https://games.butecodosdevs.com/api/compartilhagram/sfu/screen/whip");
        expect(JSON.parse(init.body)).toEqual({ roomId: "r1", socketId: "s1", sdp: "v=0 offer" });
    });

    it("releases the screen slot with on:false", async () => {
        const fetchImpl = fakeFetch(204, undefined);
        await webReleaseScreen("r1", "s1", { cookieHeader: "c=1", fetchImpl });
        const [url, init] = (fetchImpl as any).mock.calls[0];
        expect(url).toBe("https://games.butecodosdevs.com/api/compartilhagram/sfu/screen");
        expect(JSON.parse(init.body)).toEqual({ roomId: "r1", socketId: "s1", on: false });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit src/main/buteco/webApi.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implement `src/main/buteco/webApi.ts`**

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type ButecoIceServer, type ButecoResult, mapGroundRefusal } from "shared/buteco";
import { BUTECO_WEB_ORIGIN } from "shared/butecoWeb";

import { getWebCookieHeader } from "./webSession";

export const WEB_REQUEST_TIMEOUT_MS = 15_000;

export interface WebRequestOptions {
    method: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    /** `undefined` = lê do cofre de sessão (produção); `null` = sem cookie. */
    cookieHeader?: string | null;
    fetchImpl?: typeof fetch;
}

/** Request autenticada por cookie contra o site. Nunca loga headers. */
export async function webRequest<T = any>(path: string, opts: WebRequestOptions): Promise<ButecoResult<T>> {
    const doFetch = opts.fetchImpl ?? fetch;
    const cookie = opts.cookieHeader !== undefined ? opts.cookieHeader : await getWebCookieHeader();
    if (!cookie) return { ok: false, error: { code: "token_invalid", message: "Entre no Buteco Games primeiro." } };

    const headers: Record<string, string> = { accept: "application/json", cookie };
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
        res = await doFetch(`${BUTECO_WEB_ORIGIN}${path}`, {
            method: opts.method,
            headers,
            ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
            signal: AbortSignal.timeout(WEB_REQUEST_TIMEOUT_MS)
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

export type WebApiDeps = Pick<WebRequestOptions, "cookieHeader" | "fetchImpl">;

export async function fetchWebIce(deps: WebApiDeps = {}): Promise<ButecoResult<ButecoIceServer[]>> {
    const res = await webRequest<{ iceServers: ButecoIceServer[] }>("/api/rtc/ice?purpose=screenshare", {
        method: "GET",
        ...deps
    });
    if (!res.ok) return res;
    return Array.isArray(res.value?.iceServers)
        ? { ok: true, value: res.value.iceServers }
        : { ok: false, error: { code: "network", message: "Resposta inválida do servidor." } };
}

export function webPublishScreen(
    roomId: string,
    socketId: string,
    sdp: string,
    deps: WebApiDeps = {}
): Promise<ButecoResult<{ sdp: string }>> {
    return webRequest("/api/compartilhagram/sfu/screen/whip", {
        method: "POST",
        body: { roomId, socketId, sdp },
        ...deps
    });
}

/** Solta a vaga de tela no SFU (`on:false`); usado no stop e em retries. */
export function webReleaseScreen(roomId: string, socketId: string, deps: WebApiDeps = {}): Promise<ButecoResult<void>> {
    return webRequest("/api/compartilhagram/sfu/screen", {
        method: "POST",
        body: { roomId, socketId, on: false },
        ...deps
    });
}

/** Best-effort: fecha a mídia da sessão no SFU. */
export function webCloseConnection(roomId: string, socketId: string, deps: WebApiDeps = {}): Promise<ButecoResult<void>> {
    return webRequest("/api/compartilhagram/sfu/close", {
        method: "POST",
        body: { roomId, socketId },
        ...deps
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit src/main/buteco/webApi.test.ts`
Expected: PASS (6 testes).

- [ ] **Step 5: Commit**

```bash
git add src/main/buteco/webApi.ts src/main/buteco/webApi.test.ts
git commit -m "feat(buteco-web): cookie-authenticated ICE/WHIP/release API"
```

---

### Task 4: Main — roomSocket (Socket.IO da sala)

**Files:**
- Create: `src/main/buteco/roomSocket.ts`
- Test: `src/main/buteco/roomSocket.test.ts`

**Interfaces:**
- Consumes: `BUTECO_WEB_ORIGIN`, `mapLobbyRooms`, `mapRoomState`, `ButecoWebEvent` (Task 1).
- Produces: `createRoomSocket({ cookieHeader, ioImpl?, onEvent })` → `RoomSocket` com `getSocketId()`, `subscribeLobby()`, `join(roomId, password?)`, `create(name, password?)`, `leave()`, `close()`.

- [ ] **Step 1: Write the failing test**

Crie `src/main/buteco/roomSocket.test.ts`:

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { createRoomSocket } from "./roomSocket";

function fakeIo() {
    const handlers = new Map<string, Function>();
    const emitted: Array<[string, unknown]> = [];
    const socket = {
        id: "sock-1",
        on: (event: string, cb: Function) => handlers.set(event, cb),
        emit: (event: string, payload?: unknown) => emitted.push([event, payload]),
        disconnect: vi.fn(),
        removeAllListeners: vi.fn(),
        fire: (event: string, payload?: unknown) => handlers.get(event)?.(payload)
    };
    const io = vi.fn(() => socket) as any;
    return { io, socket, emitted };
}

describe("createRoomSocket", () => {
    it("connects with cookie header and subscribes the lobby on connect", () => {
        const { io, socket, emitted } = fakeIo();
        createRoomSocket({ cookieHeader: "c=1", ioImpl: io, onEvent: () => {} });

        expect(io).toHaveBeenCalledWith(
            "https://games.butecodosdevs.com",
            expect.objectContaining({ transports: ["websocket", "polling"], extraHeaders: { Cookie: "c=1" } })
        );

        socket.fire("connect");
        expect(emitted).toContainEqual(["screenshare:subscribe", undefined]);
    });

    it("forwards lobby and room state", () => {
        const { io, socket } = fakeIo();
        const events: any[] = [];
        createRoomSocket({ cookieHeader: null, ioImpl: io, onEvent: e => events.push(e) });

        socket.fire("screenshare:lobby", [{ roomId: "r1", name: "Mesa", memberCount: 2, hasPassword: false }]);
        socket.fire("screenshare:state", { roomId: "r1", name: "Mesa", members: [{ userId: "u1", displayName: "Ana" }] });
        socket.fire("screenshare:closed");
        socket.fire("screenshare:join_denied", { reason: "password" });

        expect(events[0]).toEqual({
            type: "lobby",
            rooms: [{ roomId: "r1", name: "Mesa", memberCount: 2, hasPassword: false }]
        });
        expect(events[1].type).toBe("room");
        expect(events[1].room.roomId).toBe("r1");
        expect(events[2]).toEqual({ type: "room-closed" });
        expect(events[3]).toEqual({ type: "join-denied", reason: "password" });
    });

    it("joins with watchReason choice and exposes the socket id", () => {
        const { io, socket, emitted } = fakeIo();
        const ctrl = createRoomSocket({ cookieHeader: null, ioImpl: io, onEvent: () => {} });
        ctrl.join("r1", "abc");
        expect(emitted).toContainEqual([
            "screenshare:join",
            { roomId: "r1", password: "abc", watchReason: "choice" }
        ]);
        expect(ctrl.getSocketId()).toBe("sock-1");
        ctrl.close();
        expect(socket.disconnect).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit src/main/buteco/roomSocket.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implement `src/main/buteco/roomSocket.ts`**

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { io as defaultIo } from "socket.io-client";
import { BUTECO_WEB_ORIGIN, type ButecoWebEvent, mapLobbyRooms, mapRoomState } from "shared/butecoWeb";

export interface CreateRoomSocketOptions {
    /** Header Cookie da sessão web; `null` conecta sem autenticação (não deve ocorrer). */
    cookieHeader: string | null;
    ioImpl?: typeof defaultIo;
    onEvent: (event: ButecoWebEvent) => void;
}

export interface RoomSocket {
    getSocketId(): string | null;
    subscribeLobby(): void;
    join(roomId: string, password?: string): void;
    create(name: string, password?: string): void;
    leave(): void;
    close(): void;
}

/**
 * Socket.IO do site (namespace default), autenticado por cookie via
 * `extraHeaders` — suportado pelo transport websocket do engine.io-client no
 * Node. O `socketId` é o identificador usado nos pedidos WHIP/WHEP.
 */
export function createRoomSocket(opts: CreateRoomSocketOptions): RoomSocket {
    const ioImpl = opts.ioImpl ?? defaultIo;
    const socket = ioImpl(BUTECO_WEB_ORIGIN, {
        withCredentials: true,
        transports: ["websocket", "polling"],
        ...(opts.cookieHeader ? { extraHeaders: { Cookie: opts.cookieHeader } } : {})
    });

    socket.on("connect", () => {
        socket.emit("screenshare:subscribe");
    });

    socket.on("screenshare:lobby", (payload: unknown) => {
        opts.onEvent({ type: "lobby", rooms: mapLobbyRooms(payload) });
    });

    socket.on("screenshare:state", (payload: unknown) => {
        const room = mapRoomState(payload);
        if (room) opts.onEvent({ type: "room", room });
    });

    socket.on("screenshare:join_denied", (payload: any) => {
        opts.onEvent({ type: "join-denied", reason: payload?.reason });
    });

    socket.on("screenshare:closed", () => {
        opts.onEvent({ type: "room-closed" });
    });

    socket.on("screenshare:replaced", () => {
        opts.onEvent({ type: "room-closed", reason: "replaced" });
    });

    return {
        getSocketId: () => socket.id ?? null,
        subscribeLobby: () => socket.emit("screenshare:subscribe"),
        join: (roomId, password) =>
            socket.emit("screenshare:join", { roomId, password: password ?? "", watchReason: "choice" }),
        create: (name, password) => socket.emit("screenshare:create", { name, password: password ?? "" }),
        leave: () => socket.emit("screenshare:leave"),
        close: () => {
            socket.removeAllListeners?.();
            socket.disconnect();
        }
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit src/main/buteco/roomSocket.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add src/main/buteco/roomSocket.ts src/main/buteco/roomSocket.test.ts
git commit -m "feat(buteco-web): cookie-authenticated room socket"
```

---

### Task 5: Main — webStore + registerButecoWeb + IPC + preload

**Files:**
- Create: `src/main/buteco/webStore.ts`
- Create: `src/main/buteco/web.ts`
- Test: `src/main/buteco/webStore.test.ts`
- Modify: `src/shared/IpcEvents.ts`
- Modify: `src/preload/VesktopNative.ts`
- Modify: `src/main/main.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `butecoWebStore`, `registerButecoWeb()`; IPC `BUTECO_WEB_*`/`BUTECO_ROOM_*`; `VesktopNative.buteco.web.*`.

- [ ] **Step 1: Add IPC events**

Em `src/shared/IpcEvents.ts`, antes do fechamento do enum `IpcEvents` (depois de `BUTECO_EVENT`), adicione:

```ts
    BUTECO_WEB_STATUS = "VCD_BUTECO_WEB_STATUS",
    BUTECO_WEB_LOGIN = "VCD_BUTECO_WEB_LOGIN",
    BUTECO_WEB_LOBBY = "VCD_BUTECO_WEB_LOBBY",
    BUTECO_ROOM_JOIN = "VCD_BUTECO_ROOM_JOIN",
    BUTECO_ROOM_LEAVE = "VCD_BUTECO_ROOM_LEAVE",
    BUTECO_ROOM_CREATE = "VCD_BUTECO_ROOM_CREATE",
    BUTECO_WEB_ICE = "VCD_BUTECO_WEB_ICE",
    BUTECO_WEB_PUBLISH = "VCD_BUTECO_WEB_PUBLISH",
    BUTECO_WEB_UNPUBLISH = "VCD_BUTECO_WEB_UNPUBLISH",
    BUTECO_WEB_EVENT = "VCD_BUTECO_WEB_EVENT"
```

- [ ] **Step 2: Write the failing store test**

Crie `src/main/buteco/webStore.test.ts`:

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { createButecoWebStore } from "./webStore";

describe("butecoWebStore", () => {
    it("starts logged out with no lobby", () => {
        const store = createButecoWebStore();
        expect(store.getState()).toEqual({
            status: { loggedIn: false, user: null },
            lobby: null,
            room: null
        });
    });

    it("patches state and notifies subscribers", () => {
        const store = createButecoWebStore();
        const cb = vi.fn();
        store.onEvent(cb);
        store.patch({ lobby: [{ roomId: "r1", name: "Mesa", memberCount: 1, hasPassword: false }] });
        store.emitEvent({ type: "lobby", rooms: [] });
        expect(store.getState().lobby).toHaveLength(1);
        expect(cb).toHaveBeenCalledWith({ type: "lobby", rooms: [] });
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:unit src/main/buteco/webStore.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 4: Implement `src/main/buteco/webStore.ts`**

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoWebEvent, ButecoWebState } from "shared/butecoWeb";

export interface ButecoWebStore {
    getState(): ButecoWebState;
    patch(partial: Partial<ButecoWebState>): void;
    emitEvent(event: ButecoWebEvent): void;
    onEvent(cb: (event: ButecoWebEvent) => void): () => void;
}

export function createButecoWebStore(): ButecoWebStore {
    let state: ButecoWebState = { status: { loggedIn: false, user: null }, lobby: null, room: null };
    const listeners = new Set<(event: ButecoWebEvent) => void>();

    return {
        getState: () => state,
        patch: partial => (state = { ...state, ...partial }),
        emitEvent: event => listeners.forEach(cb => cb(event)),
        onEvent(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        }
    };
}

export const butecoWebStore = createButecoWebStore();
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:unit src/main/buteco/webStore.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 6: Implement `src/main/buteco/web.ts`**

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { webContents } from "electron";
import { IpcEvents } from "shared/IpcEvents";
import type { ButecoWebEnvelope, ButecoWebEvent } from "shared/butecoWeb";

import { handle } from "../utils/ipcWrappers";
import { createRoomSocket, type RoomSocket } from "./roomSocket";
import { fetchWebIce, webCloseConnection, webPublishScreen, webReleaseScreen } from "./webApi";
import { getWebCookieHeader, getWebStatus, openWebLoginWindow } from "./webSession";
import { butecoWebStore } from "./webStore";

let roomSocket: RoomSocket | null = null;

function broadcast(event?: ButecoWebEvent) {
    const envelope: ButecoWebEnvelope = { state: butecoWebStore.getState(), event };
    for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        try {
            wc.send(IpcEvents.BUTECO_WEB_EVENT, envelope);
        } catch {
            // renderer pode morrer entre o check e o send
        }
    }
}

function handleRoomEvent(event: ButecoWebEvent) {
    switch (event.type) {
        case "lobby":
            butecoWebStore.patch({ lobby: event.rooms });
            break;
        case "room":
            butecoWebStore.patch({ room: event.room });
            break;
        case "room-closed":
            butecoWebStore.patch({ room: null });
            break;
        default:
            break;
    }
    broadcast(event);
}

async function ensureRoomSocket(): Promise<RoomSocket | null> {
    if (roomSocket) return roomSocket;
    const cookie = await getWebCookieHeader();
    if (!cookie) return null;
    roomSocket = createRoomSocket({ cookieHeader: cookie, onEvent: handleRoomEvent });
    return roomSocket;
}

export function registerButecoWeb() {
    handle(IpcEvents.BUTECO_WEB_STATUS, async () => {
        const status = await getWebStatus();
        butecoWebStore.patch({ status });
        broadcast({ type: "status", status });
        return status;
    });

    handle(IpcEvents.BUTECO_WEB_LOGIN, async () => {
        const status = await openWebLoginWindow();
        butecoWebStore.patch({ status });
        if (status.loggedIn) await ensureRoomSocket();
        broadcast({ type: "status", status });
        return status;
    });

    handle(IpcEvents.BUTECO_WEB_LOBBY, async () => {
        const socket = await ensureRoomSocket();
        socket?.subscribeLobby();
        return butecoWebStore.getState().lobby;
    });

    handle(IpcEvents.BUTECO_ROOM_JOIN, async (_, roomId: string, password: string) => {
        const socket = await ensureRoomSocket();
        if (!socket) {
            return { ok: false, error: { code: "token_invalid", message: "Entre no Buteco Games primeiro." } };
        }
        socket.join(roomId, password);
        return { ok: true, value: undefined };
    });

    handle(IpcEvents.BUTECO_ROOM_CREATE, async (_, name: string, password: string) => {
        const socket = await ensureRoomSocket();
        if (!socket) {
            return { ok: false, error: { code: "token_invalid", message: "Entre no Buteco Games primeiro." } };
        }
        socket.create(name, password);
        return { ok: true, value: undefined };
    });

    handle(IpcEvents.BUTECO_ROOM_LEAVE, () => {
        roomSocket?.leave();
        butecoWebStore.patch({ room: null });
        broadcast({ type: "room", room: null });
        return { ok: true, value: undefined };
    });

    handle(IpcEvents.BUTECO_WEB_ICE, () => fetchWebIce());

    handle(IpcEvents.BUTECO_WEB_PUBLISH, async (_, sdp: string) => {
        const room = butecoWebStore.getState().room;
        const socketId = roomSocket?.getSocketId() ?? null;
        if (!room || !socketId) {
            return { ok: false, error: { code: "token_invalid", message: "Entre numa sala primeiro." } };
        }
        return webPublishScreen(room.roomId, socketId, sdp);
    });

    handle(IpcEvents.BUTECO_WEB_UNPUBLISH, async () => {
        const room = butecoWebStore.getState().room;
        const socketId = roomSocket?.getSocketId() ?? null;
        if (!room || !socketId) return { ok: true, value: undefined };
        const released = await webReleaseScreen(room.roomId, socketId);
        void webCloseConnection(room.roomId, socketId);
        return released;
    });
}
```

- [ ] **Step 7: Wire into main**

Em `src/main/main.ts`:

```ts
import { registerButeco } from "./buteco";
import { registerButecoWeb } from "./buteco/web";
```

E, no bloco de ready (junto de `registerButeco()`):

```ts
        registerScreenShareHandler();
        registerButeco();
        registerButecoWeb();
        registerMediaPermissionsHandler();
```

- [ ] **Step 8: Expose `VesktopNative.buteco.web`**

Em `src/preload/VesktopNative.ts`, adicione imports de tipo:

```ts
import type { ButecoIceServer, ButecoResult } from "shared/buteco";
import type { ButecoRoomSummary, ButecoWebEnvelope, ButecoWebStatus } from "shared/butecoWeb";
```

E dentro de `buteco: { ... }`, depois de `onEvent`:

```ts
        web: {
            status: () => invoke<ButecoWebStatus>(IpcEvents.BUTECO_WEB_STATUS),
            login: () => invoke<ButecoWebStatus>(IpcEvents.BUTECO_WEB_LOGIN),
            lobby: () => invoke<ButecoRoomSummary[] | null>(IpcEvents.BUTECO_WEB_LOBBY),
            joinRoom: (roomId: string, password?: string) =>
                invoke<ButecoResult<void>>(IpcEvents.BUTECO_ROOM_JOIN, roomId, password ?? ""),
            createRoom: (name: string, password?: string) =>
                invoke<ButecoResult<void>>(IpcEvents.BUTECO_ROOM_CREATE, name, password ?? ""),
            leaveRoom: () => invoke<ButecoResult<void>>(IpcEvents.BUTECO_ROOM_LEAVE),
            ice: () => invoke<ButecoResult<ButecoIceServer[]>>(IpcEvents.BUTECO_WEB_ICE),
            publish: (sdp: string) => invoke<ButecoResult<{ sdp: string }>>(IpcEvents.BUTECO_WEB_PUBLISH, sdp),
            unpublish: () => invoke<ButecoResult<void>>(IpcEvents.BUTECO_WEB_UNPUBLISH),
            onEvent: (cb: (envelope: ButecoWebEnvelope) => void) => {
                ipcRenderer.on(IpcEvents.BUTECO_WEB_EVENT, (_e, envelope) => cb(envelope));
            }
        }
```

- [ ] **Step 9: Typecheck + unit**

Run: `pnpm testTypes && pnpm test:unit src/main/buteco/webStore.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/shared/IpcEvents.ts src/main/buteco/webStore.ts src/main/buteco/webStore.test.ts src/main/buteco/web.ts src/main/main.ts src/preload/VesktopNative.ts
git commit -m "feat(buteco-web): main registration, store and preload API"
```

---

### Task 6: Renderer — webState + hook

**Files:**
- Create: `src/renderer/buteco/webState.ts`
- Create: `src/renderer/buteco/useButecoWeb.ts`
- Test: `src/renderer/buteco/webState.test.ts`

**Interfaces:**
- Consumes: `ButecoWebEnvelope`, `ButecoWebState` (Task 1).
- Produces: `getButecoWebState()`, `applyButecoWebEnvelope(envelope)`, `subscribeButecoWeb(cb)`, `useButecoWebState()`.

- [ ] **Step 1: Write the failing test**

Crie `src/renderer/buteco/webState.test.ts` (importa só o store puro — sem webpack):

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyButecoWebEnvelope, getButecoWebState, resetButecoWebState, subscribeButecoWeb } from "./webState";

describe("butecoWebState", () => {
    beforeEach(() => resetButecoWebState());

    it("applies an envelope and notifies subscribers", () => {
        const cb = vi.fn();
        subscribeButecoWeb(cb);
        applyButecoWebEnvelope({
            state: {
                status: { loggedIn: true, user: { id: "u1", displayName: "Ana" } },
                lobby: [],
                room: null
            },
            event: { type: "status", status: { loggedIn: true, user: { id: "u1", displayName: "Ana" } } }
        });
        expect(getButecoWebState().status.loggedIn).toBe(true);
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it("ignores malformed envelopes", () => {
        const cb = vi.fn();
        subscribeButecoWeb(cb);
        applyButecoWebEnvelope(undefined as any);
        expect(cb).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit src/renderer/buteco/webState.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implement `src/renderer/buteco/webState.ts`**

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoWebEnvelope, ButecoWebState } from "shared/butecoWeb";

function initialState(): ButecoWebState {
    return { status: { loggedIn: false, user: null }, lobby: null, room: null };
}

let state: ButecoWebState = initialState();
const listeners = new Set<() => void>();

export function getButecoWebState(): ButecoWebState {
    return state;
}

export function resetButecoWebState(): void {
    state = initialState();
}

export function applyButecoWebEnvelope(envelope: ButecoWebEnvelope): void {
    if (!envelope?.state) return;

    state = envelope.state;
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            // um assinante quebrado não bloqueia os outros
        }
    }
}

export function subscribeButecoWeb(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit src/renderer/buteco/webState.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Implement `src/renderer/buteco/useButecoWeb.ts`**

```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { onceReady } from "@vencord/types/webpack";
import { useEffect, useState } from "@vencord/types/webpack/common";
import type { ButecoWebEnvelope, ButecoWebState } from "shared/butecoWeb";

import { applyButecoWebEnvelope, getButecoWebState, subscribeButecoWeb } from "./webState";

onceReady.then(() => {
    VesktopNative.buteco.web.onEvent(envelope => applyButecoWebEnvelope(envelope as ButecoWebEnvelope));
    void VesktopNative.buteco.web.status();
});

/** Estado da sessão/salas; assina o envelope uma única vez por processo. */
export function useButecoWebState(): ButecoWebState {
    const [state, setState] = useState(getButecoWebState());

    useEffect(() => {
        setState(getButecoWebState());
        return subscribeButecoWeb(() => setState(getButecoWebState()));
    }, []);

    return state;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/buteco/webState.ts src/renderer/buteco/webState.test.ts src/renderer/buteco/useButecoWeb.ts
git commit -m "feat(buteco-web): renderer web state store and hook"
```

---

### Task 7: UI — ButecoPanel com sessão/lobby/sala

**Files:**
- Modify: `src/renderer/buteco/ButecoPanel.tsx`
- Modify: `src/renderer/buteco/VoicePanelButton.tsx`
- Modify: `src/renderer/components/ScreenSharePicker.tsx`

**Interfaces:**
- Consumes: `useButecoWebState` (Task 6), `VesktopNative.buteco.web.*` (Task 5).
- Produces: painel com 3 estados (deslogado / lobby / sala); props finais `{ pick, onPick, onStart, error, session }`.

- [ ] **Step 1: Reescrever o topo do `ButecoPanel`**

Substitua a assinatura e o bloco de pairing (o `if (paired && ...)`, `if (!paired)`, `PairForm`) pelo fluxo web. O topo do componente passa a ser:

```tsx
export function ButecoPanel({
    pick,
    onPick,
    onStart,
    error,
    session
}: {
    pick: ButecoPick | null;
    onPick: (p: ButecoPick) => void;
    onStart: () => void;
    /** Última falha de publicação a exibir (a UI web cuida dos próprios erros). */
    error: ButecoError | null;
    /** Sessão legada (helper); na via web passa `null` e os defaults valem. */
    session: ButecoWireSession | null;
}) {
    const web = useButecoWebState();

    const [sources] = useAwaiter<ButecoSource[]>(
        () => (web.room ? VesktopNative.buteco.listSources() : Promise.resolve([])),
        { fallbackValue: [], deps: [web.room?.roomId] }
    );

    if (!web.status.loggedIn) return <ButecoLogin />;
    if (!web.room) return <ButecoRooms lobby={web.lobby} />;

    return (
        <div>
            <ButecoRoomHeader room={web.room} />
            {error ? <Paragraph>{BUTECO_ERROR_MESSAGES[error.code]}</Paragraph> : null}
            <HeadingTertiary>Fonte</HeadingTertiary>
            {/* ... manter a grade de fontes, qualidade e áudio exatamente como estão ... */}
        </div>
    );
}
```

Adicione os três componentes auxiliares no mesmo arquivo:

```tsx
function ButecoLogin() {
    const [busy, setBusy] = useState(false);
    return (
        <div>
            <HeadingTertiary>Entrar no Buteco Games</HeadingTertiary>
            <Paragraph>
                Faça login uma vez no site da Buteco para entrar nas salas e compartilhar a tela sem código.
            </Paragraph>
            <Button
                disabled={busy}
                onClick={async () => {
                    setBusy(true);
                    try {
                        await VesktopNative.buteco.web.login();
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                {busy ? "Abrindo login..." : "Entrar"}
            </Button>
        </div>
    );
}

function ButecoRooms({ lobby }: { lobby: ButecoRoomSummary[] | null }) {
    const [passwordFor, setPasswordFor] = useState<string | null>(null);
    const [password, setPassword] = useState("");
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [newPassword, setNewPassword] = useState("");

    useEffect(() => {
        void VesktopNative.buteco.web.lobby();
    }, []);

    return (
        <div>
            <HeadingTertiary>Salas abertas</HeadingTertiary>
            {lobby === null ? (
                <Paragraph>Carregando salas...</Paragraph>
            ) : lobby.length === 0 ? (
                <Paragraph>Nenhuma sala aberta agora.</Paragraph>
            ) : (
                lobby.map(room => (
                    <div key={room.roomId}>
                        <span>
                            {room.name} · {room.memberCount} na sala {room.hasPassword ? "🔒" : ""}
                        </span>
                        {passwordFor === room.roomId ? (
                            <>
                                <input
                                    type="password"
                                    value={password}
                                    placeholder="Senha"
                                    onChange={e => setPassword(e.currentTarget.value)}
                                />
                                <Button onClick={() => void VesktopNative.buteco.web.joinRoom(room.roomId, password)}>
                                    Entrar
                                </Button>
                            </>
                        ) : (
                            <Button
                                onClick={() => {
                                    if (room.hasPassword) {
                                        setPasswordFor(room.roomId);
                                        setPassword("");
                                        return;
                                    }
                                    void VesktopNative.buteco.web.joinRoom(room.roomId);
                                }}
                            >
                                Entrar
                            </Button>
                        )}
                    </div>
                ))
            )}

            <HeadingTertiary>Criar sala</HeadingTertiary>
            {creating ? (
                <>
                    <input value={name} placeholder="Nome da sala" onChange={e => setName(e.currentTarget.value)} />
                    <input
                        value={newPassword}
                        placeholder="Senha (opcional)"
                        onChange={e => setNewPassword(e.currentTarget.value)}
                    />
                    <Button
                        disabled={!name}
                        onClick={() => void VesktopNative.buteco.web.createRoom(name, newPassword)}
                    >
                        Criar
                    </Button>
                </>
            ) : (
                <Button variant="secondary" onClick={() => setCreating(true)}>
                    Criar sala
                </Button>
            )}
        </div>
    );
}

function ButecoRoomHeader({ room }: { room: ButecoRoomState }) {
    return (
        <div>
            <HeadingTertiary>{room.name}</HeadingTertiary>
            <Paragraph>
                {room.members.length} na sala ·{" "}
                <Button variant="secondary" onClick={() => void VesktopNative.buteco.web.leaveRoom()}>
                    Sair da sala
                </Button>
            </Paragraph>
        </div>
    );
}
```

Ajuste os imports do arquivo: adicione `useEffect` (de `@vencord/types/webpack/common`), `type { ButecoRoomState, ButecoRoomSummary } from "shared/butecoWeb"`, `useButecoWebState` de `./useButecoWeb`; remova `isRepairErrorCode` se ficar sem uso.

- [ ] **Step 2: Atualizar as duas chamadas do painel**

`src/renderer/buteco/VoicePanelButton.tsx` (modal):
- Remova os estados `paired`, `needsRepair`, a função `onPair`, os imports `pairButeco`, `getLatestButecoSession`, `isRepairErrorCode`.
- Mantenha só `pick` e `error`.
- Render:

```tsx
            <ButecoPanel
                pick={pick}
                onPick={setPick}
                error={error}
                session={null}
                onStart={onStart}
            />
```

`src/renderer/components/ScreenSharePicker.tsx` (via picker):
- No bloco `mode === "buteco"`, remova `paired`, `onPair`, `needsRepair` e troque `session={latestButecoSession}` por `session={null}`:

```tsx
                <ButecoPanel
                    pick={butecoPick}
                    onPick={setButecoPick}
                    error={butecoError}
                    session={null}
                    onStart={() => {
                        if (!butecoPick) return;
                        submit({
                            id: "",
                            mode: "buteco",
                            contentHint: settings.contentHint,
                            audio: settings.audio,
                            ...butecoPick
                        } as StreamPick);
                    }}
                />
```

- Remova o estado/função de pairing do picker que ficou sem uso (`paired`, `handlePair`, `needsRepair` e o efeito que os alimentava), e os imports correspondentes. Se `latestButecoSession` só era usado ali, mantenha a variável (legado do helper) mas pare de passá-la ao painel.

- [ ] **Step 3: Typecheck**

Run: `pnpm testTypes`
Expected: PASS. Corrija imports não usados (lint) na sequência.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/buteco/ButecoPanel.tsx src/renderer/buteco/VoicePanelButton.tsx src/renderer/components/ScreenSharePicker.tsx
git commit -m "feat(buteco-web): panel session/lobby/room UI"
```

---

### Task 8: Publicação via web (start/stop)

**Files:**
- Modify: `src/renderer/components/ScreenSharePicker.tsx` (`startButecoPublish`)

**Interfaces:**
- Consumes: `VesktopNative.buteco.web.{ice,publish,unpublish}` (Task 5), `createButecoController` (existente).
- Produces: `startButecoPublish(pick)` publicando via WHIP do site, sem pairing.

- [ ] **Step 1: Reescrever as dependências do controller**

Em `startButecoPublish`, troque a montagem do controller para buscar ICE na sessão web e usar os endpoints web:

```ts
export async function startButecoPublish(pick: ButecoPick): Promise<ButecoResult<void>> {
    try {
        await stopActiveButeco();
        await VesktopNative.buteco.armCapture(pick.sourceId);

        const ice = (await VesktopNative.buteco.web.ice()) as ButecoResult<ButecoIceServer[]>;
        if (!ice.ok) {
            setLatestButecoError(ice.error);
            await VesktopNative.buteco.cancelCapture();
            return ice;
        }

        const webSession = {
            iceServers: ice.value,
            limits: { screenAudioAllowed: true, maxHeight: 1440, maxFps: 60, maxVideoKbps: 8000, audioKbps: 128 }
        } as ButecoSession;

        const controller = createButecoController({
            getSession: () => webSession,
            getDisplayMedia: opts => navigator.mediaDevices.getDisplayMedia(opts),
            getUserMedia: opts => navigator.mediaDevices.getUserMedia(opts),
            createPeerConnection: iceServers => new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" }),
            publish: async sdp => {
                const res = (await VesktopNative.buteco.web.publish(sdp)) as ButecoResult<{ sdp: string }>;
                return res.ok ? { ok: true, value: { sdp: res.value.sdp, streamId: "" } } : res;
            },
            unpublish: () => VesktopNative.buteco.web.unpublish() as Promise<ButecoResult<void>>,
            getVirtmicDeviceId: findVirtmicDeviceId,
            virtmic: {
                start: nodes => VesktopNative.virtmic.start(nodes as Node[]),
                stop: () => VesktopNative.virtmic.stop(),
                unmute: () => VesktopNative.virtmic.unmute()
            }
        });

        activeButecoController = controller;

        const quality = clampQuality(pick, undefined);

        const res = await controller.start({
            sourceId: pick.sourceId,
            videoKind: pick.videoKind,
            videoLabel: pick.videoLabel,
            height: quality.height,
            fps: quality.fps,
            mic: pick.mic,
            contentHint: pick.contentHint ?? "motion",
            includeAudioNodes: pick.includeAudioNodes ?? [],
            audioLabel: pick.audioLabel ?? null
        } satisfies StartOptions);

        // ... restante do tratamento de erro/sucesso igual ao atual ...
```

Mantenha o resto da função (tratamento de erro, `setButecoPublishing(true)`, etc.) como está.

- [ ] **Step 2: Ajustar imports**

- `ButecoIceServer` já vem de `shared/buteco`? Adicione ao import de tipos se faltar.
- `clampQuality(pick, null)` — confirme que `clampQuality` aceita `limits` opcional/nulo (hoje recebe `latestButecoSession?.limits`).
- `latestButecoSession` deixa de ser usado por `startButecoPublish` (segue existindo para o helper legado).

- [ ] **Step 3: Typecheck + unit**

Run: `pnpm testTypes && pnpm test:unit`
Expected: PASS (todos os testes).

- [ ] **Step 4: Manual smoke (com o app rodando)**

1. Abrir o painel Buteco → "Entrar" (login no site).
2. Ver o lobby; entrar numa sala aberta (ou criar).
3. Escolher fonte/qualidade → Iniciar → confirmar o stream aparecendo no site.
4. Parar → confirmar que a vaga de tela foi liberada.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/ScreenSharePicker.tsx src/renderer/buteco/ButecoPanel.tsx
git commit -m "feat(buteco-web): publish via site WHIP without pairing"
```

---

### Task 9: Verificação final

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-buteco-games-web-session-design.md` (status)

- [ ] **Step 1: Rodar a suíte completa**

Run: `pnpm lint && pnpm testTypes && pnpm test:unit && pnpm build`
Expected: tudo verde.

- [ ] **Step 2: Revisar código morto**

- `rg -n "pairButeco|paired=|onPair=" src/renderer` não deve achar chamadas na UI.
- `pairButeco`/`latestButecoSession` do helper continuam exportados (legado), sem uso na UI — ok.

- [ ] **Step 3: Atualizar a spec**

Mudar `Status:` para `implementado (Fase 1)`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-01-buteco-games-web-session-design.md
git commit -m "docs(buteco-web): mark phase 1 implemented"
```

---

## Self-Review

**Spec coverage:**
- Sessão web (login/status) → Tasks 2, 5, 6, 7. ✓
- Socket com cookie → Task 4. ✓
- ICE/WHIP/release/close → Task 3. ✓
- Estado + envelope + IPC/preload → Task 5. ✓
- UI lobby/entrar/criar/sair → Task 7. ✓
- Publicar sem código → Task 8. ✓
- Legado helper preservado → Task 8 (não removido). ✓
- Testes → Tasks 1–6. ✓
- Fase 2 (viewer) → fora do plano, por design. ✓

**Placeholder scan:** sem TBD; passos de código têm código real. O trecho "manter a grade de fontes/qualidade/áudio como estão" refere-se a código já existente no arquivo (não é placeholder de implementação nova).

**Type consistency:** `ButecoWebEvent`/`ButecoWebState` definidos na Task 1 e usados em 4–7; `RoomSocket` definido na Task 4 e usado na 5; `web.*` da preload (Task 5) consumido em 7–8. `mapLobbyRooms` aceita array e `{ rooms }` — cobre o payload real do site sem alterar assinatura.
