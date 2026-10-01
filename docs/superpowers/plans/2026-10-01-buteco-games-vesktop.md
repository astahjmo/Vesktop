# Buteco Games no Vesktop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compartilhar a tela do Vesktop pelo SFU do Buteco Games, com um toggle `Native | Buteco Games` no Screen Share Picker, sem enviar mídia ao SFU do Discord.

**Architecture:** Módulo self-contained no Vesktop (`src/main/buteco/` + `src/renderer/buteco/`), sem fork do Vencord. Rede (HTTP/Socket.IO/segredos) fica no main; `RTCPeerConnection` (WebRTC) e a UI ficam no renderer. A captura usa uma "captura armada" de uso único no handler de display-media para não reabrir o picker.

**Tech Stack:** Electron 44, TypeScript, esbuild, socket.io-client, React 19 (via `@vencord/types`), venmic (`VesktopNative.virtmic`), vitest (novo, dev-only).

**Spec:** `docs/superpowers/specs/2026-10-01-buteco-games-vesktop-design.md`

## Global Constraints

- **Sem fork do Vencord.** Não usar o sistema de plugins do Vencord; não criar `userplugins`.
- **Câmera fora de escopo.** O backend do Buteco só aceita `videoKind: "screen" | "window"`.
- **Base URL:** `https://games.butecodosdevs.com` (nunca configurável pelo renderer; hardcoded no main).
- **Timeout de requisição:** 15000 ms (`AbortSignal.timeout(15000)`).
- **`GROUND_PROTOCOL = 1`** em `exchange` e no auth do socket.
- **Nada de mídia ao Discord:** no modo Buteco o handler de display-media responde `callback({})`.
- **IPC só com `handle`/`handleSync`** de `src/main/utils/ipcWrappers.ts` (validação de sender preservada).
- **Estilo:** 4 espaços, double quotes, header GPL-3.0 em todo arquivo (o lint `simple-header` exige).
- **`pnpm test` já é `lint && testTypes`** — não sobrescrever; o runner unitário é `pnpm test:unit`.
- **IPC payloads** devem ser serializáveis por structured-clone.

---

## File Structure

**Criar:**
- `src/shared/buteco.ts` — tipos e códigos de erro compartilhados main/renderer.
- `src/main/buteco/ground.ts` — base URL, fetch com Bearer/timeout, mapeamento de erro.
- `src/main/buteco/pairing.ts` — `normalizePairingCode`, `exchange`, token vault.
- `src/main/buteco/whip.ts` — publish (retry busy), unpublish, refreshIce, unpair.
- `src/main/buteco/socket.ts` — cliente socket.io em `/helper`.
- `src/main/buteco/capture.ts` — captura armada de uso único.
- `src/main/buteco/store.ts` — estado em memória + emissão de eventos.
- `src/main/buteco/index.ts` — `registerButeco()` e handlers IPC.
- `src/renderer/buteco/controller.ts` — `RTCPeerConnection` + áudio.
- `src/renderer/buteco/ButecoPanel.tsx` — aba Buteco no picker.
- `src/renderer/buteco/streamState.ts` — emulação do estado de stream do Discord (spike).
- `vitest.config.ts` — config do runner.
- Testes: `src/**/buteco/*.test.ts`, `src/main/buteco/__tests__/*.test.ts`.

**Modificar:**
- `src/shared/IpcEvents.ts` — novos eventos `BUTECO_*`.
- `src/shared/settings.d.ts` — `butecoMode?: "native" | "buteco"` em `Settings`.
- `src/main/screenShare.ts` — consumir captura armada / cancelar Go Live.
- `src/main/buteco` wiring em `src/main/main.ts` (`registerButeco()`).
- `src/preload/VesktopNative.ts` — `VesktopNative.buteco`.
- `src/renderer/components/ScreenSharePicker.tsx` — toggle + painel + `mode` no `StreamPick`.
- `package.json` — devDependency `vitest`, script `test:unit`.

---

## Task 1: Shared types + vitest setup

**Files:**
- Create: `src/shared/buteco.ts`
- Create: `vitest.config.ts`
- Modify: `package.json`
- Test: `src/shared/buteco.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ButecoLimits`, `ButecoIceServer`, `ButecoSession`, `ButecoPublishMeta`, `ButecoPublishResult`, `ButecoError`, `ButecoErrorCode`, `ButecoResult<T>`, `ButecoSource`, `ButecoPhase`, `ButecoEvent`, `BUTECO_APP_BASE`, `mapGroundRefusal`.

- [ ] **Step 1: Add vitest devDependency and script**

Run:
```bash
pnpm add -D vitest@^2
```
Then edit `package.json` scripts to add (leave `test` untouched):
```json
"test:unit": "vitest run"
```

- [ ] **Step 2: Create vitest config**

Create `vitest.config.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"]
    }
});
```

- [ ] **Step 3: Write the failing test**

Create `src/shared/buteco.test.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { mapGroundRefusal } from "./buteco";

describe("mapGroundRefusal", () => {
    it("maps known server codes", () => {
        expect(mapGroundRefusal(409, { error: "screen_taken" }).code).toBe("screen_taken");
    });

    it("maps 401 to token_invalid", () => {
        expect(mapGroundRefusal(401, {}).code).toBe("token_invalid");
    });

    it("maps 426 to client_outdated", () => {
        expect(mapGroundRefusal(426, {}).code).toBe("client_outdated");
    });

    it("carries retry-after for busy", () => {
        const err = mapGroundRefusal(409, { error: "busy" }, "2");
        expect(err.retryAfterSec).toBe(2);
    });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test:unit src/shared/buteco.test.ts`
Expected: FAIL — `mapGroundRefusal` not exported / module not found.

- [ ] **Step 5: Write the shared types**

Create `src/shared/buteco.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const BUTECO_APP_BASE = "https://games.butecodosdevs.com";
export const BUTECO_PROTOCOL = 1;
export const BUTECO_REQUEST_TIMEOUT_MS = 15_000;

export type ButecoPhase = "idle" | "pairing" | "ready" | "selecting" | "starting" | "live" | "reconnecting" | "stopping";

export interface ButecoLimits {
    screenAudioAllowed: boolean;
    maxHeight: 720 | 1080 | 1440;
    maxFps: 30 | 60;
    maxVideoKbps: number;
    audioKbps: number;
}

export interface ButecoIceServer {
    urls: string | string[];
    username?: string;
    credential?: string;
}

export interface ButecoTakenBy {
    userId: string;
    displayName: string;
    self: boolean;
}

export interface ButecoRoom {
    id: string;
    slug: string;
    name: string;
    url?: string;
}

export interface ButecoSession {
    token: string;
    tokenExpiresAt: string;
    room: ButecoRoom;
    user: { id: string; displayName: string };
    socket: { url: string; path: "/socket.io"; namespace: "/helper" };
    iceServers: ButecoIceServer[];
    limits: ButecoLimits;
    screen: { takenBy: ButecoTakenBy | null };
    serverNow: string;
}

export interface ButecoPublishMeta {
    videoKind: "screen" | "window";
    videoLabel: string;
    audioLabel: string | null;
    mic: boolean;
    height: 720 | 1080 | 1440;
    fps: 30 | 60;
}

export interface ButecoPublishResult {
    sdp: string;
    streamId: string;
}

export interface ButecoSource {
    id: string;
    name: string;
    kind: "screen" | "window";
    thumbnailDataUrl?: string;
}

export type ButecoErrorCode =
    | "invalid_code_format"
    | "token_invalid"
    | "client_outdated"
    | "network"
    | "unsupported"
    | "permission_denied"
    | "video_capture_failed"
    | "screen_audio_disabled"
    | "screen_taken"
    | "screen_taken_self"
    | "sfu_unavailable"
    | "device_error"
    | "busy";

export interface ButecoError {
    code: ButecoErrorCode;
    message: string;
    retryAfterSec?: number;
}

export type ButecoResult<T> = { ok: true; value: T } | { ok: false; error: ButecoError };

export type ButecoEvent =
    | { type: "connection"; state: "connected" | "reconnecting" | "offline" }
    | { type: "revoked"; reason: string }
    | { type: "stop_requested"; by: "owner" | "room_owner" | "admin" }
    | { type: "screen_lost"; reason: "sfu_error" | "reset" | "taken_over" }
    | { type: "session"; session: ButecoSession };

const KNOWN_ERROR_CODES: readonly ButecoErrorCode[] = [
    "invalid_code_format",
    "token_invalid",
    "client_outdated",
    "network",
    "unsupported",
    "permission_denied",
    "video_capture_failed",
    "screen_audio_disabled",
    "screen_taken",
    "screen_taken_self",
    "sfu_unavailable",
    "device_error",
    "busy"
];

/** Maps an HTTP refusal from the Ground into a stable client error. */
export function mapGroundRefusal(status: number, body: any, retryAfter?: string | null): ButecoError {
    const serverCode = typeof body?.error === "string" ? body.error : undefined;
    const code: ButecoErrorCode =
        serverCode && (KNOWN_ERROR_CODES as readonly string[]).includes(serverCode)
            ? (serverCode as ButecoErrorCode)
            : status === 401
              ? "token_invalid"
              : status === 426
                ? "client_outdated"
                : status === 409
                  ? "screen_taken"
                  : "network";

    const error: ButecoError = { code, message: serverCode ?? `HTTP ${status}` };
    if (code === "busy" && retryAfter) {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs)) error.retryAfterSec = secs;
    }
    return error;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test:unit src/shared/buteco.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/shared/buteco.ts src/shared/buteco.test.ts
git commit -m "feat(buteco): shared types, error mapping and vitest runner"
```

---

## Task 2: Main — ground.ts (fetch + Bearer + timeout)

**Files:**
- Create: `src/main/buteco/ground.ts`
- Test: `src/main/buteco/ground.test.ts`

**Interfaces:**
- Consumes: `BUTECO_APP_BASE`, `BUTECO_REQUEST_TIMEOUT_MS`, `mapGroundRefusal`, `ButecoResult`, `ButecoError` from Task 1.
- Produces: `groundRequest<T>(path, opts)` where `opts = { method: "GET"|"POST"|"DELETE"; body?: unknown; token?: string; fetchImpl?: typeof fetch }`.

- [ ] **Step 1: Write the failing test**

Create `src/main/buteco/ground.test.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { groundRequest } from "./ground";

function fakeFetch(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("groundRequest", () => {
    it("attaches bearer token and parses JSON", async () => {
        const fetchImpl = fakeFetch(200, { hello: "world" });
        const res = await groundRequest<{ hello: string }>("/api/x", { method: "POST", body: { a: 1 }, token: "tok", fetchImpl });
        expect(res).toEqual({ ok: true, value: { hello: "world" } });
        const [url, init] = (fetchImpl as any).mock.calls[0];
        expect(url).toBe("https://games.butecodosdevs.com/api/x");
        expect((init.headers as any).authorization).toBe("Bearer tok");
    });

    it("returns network error on fetch throw", async () => {
        const fetchImpl = vi.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch;
        const res = await groundRequest("/api/x", { method: "GET", fetchImpl });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("network");
    });

    it("maps a 401 refusal", async () => {
        const fetchImpl = fakeFetch(401, {});
        const res = await groundRequest("/api/x", { method: "GET", fetchImpl });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("token_invalid");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit src/main/buteco/ground.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ground.ts**

Create `src/main/buteco/ground.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BUTECO_APP_BASE, BUTECO_REQUEST_TIMEOUT_MS, mapGroundRefusal } from "shared/buteco";
import type { ButecoResult } from "shared/buteco";

export interface GroundRequestOptions {
    method: "GET" | "POST" | "DELETE";
    body?: unknown;
    token?: string;
    fetchImpl?: typeof fetch;
}

/** Performs an authenticated request against the Buteco Ground. */
export async function groundRequest<T = any>(
    path: string,
    opts: GroundRequestOptions
): Promise<ButecoResult<T>> {
    const doFetch = opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;

    let res: Response;
    try {
        res = await doFetch(`${BUTECO_APP_BASE}${path}`, {
            method: opts.method,
            headers,
            ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
            signal: AbortSignal.timeout(BUTECO_REQUEST_TIMEOUT_MS)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit src/main/buteco/ground.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/buteco/ground.ts src/main/buteco/ground.test.ts
git commit -m "feat(buteco): ground HTTP client"
```

---

## Task 3: Main — pairing.ts (exchange + token vault)

**Files:**
- Create: `src/main/buteco/pairing.ts`
- Test: `src/main/buteco/pairing.test.ts`

**Interfaces:**
- Consumes: `groundRequest` (Task 2), `BUTECO_PROTOCOL`, `ButecoSession`, `ButecoResult`.
- Produces: `normalizePairingCode(raw): string | null`; `exchangeCode(code): Promise<ButecoResult<ButecoSession>>`; `tokenVault` with `set(session)`, `getToken(now?)`, `clear()`, `getSession()`.

- [ ] **Step 1: Write the failing test**

Create `src/main/buteco/pairing.test.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it } from "vitest";

import { createTokenVault, normalizePairingCode } from "./pairing";

describe("normalizePairingCode", () => {
    it("uppercases and strips spaces/dashes", () => {
        expect(normalizePairingCode(" ab-12 3c ")).toBe("AB123C");
    });
    it("rejects empty and invalid chars", () => {
        expect(normalizePairingCode("   ")).toBeNull();
        expect(normalizePairingCode("ab$c")).toBeNull();
    });
});

describe("tokenVault", () => {
    let vault: ReturnType<typeof createTokenVault>;
    beforeEach(() => {
        vault = createTokenVault();
    });

    it("returns null before set", () => {
        expect(vault.getToken()).toBeNull();
    });

    it("returns token before expiry and null after", () => {
        vault.set({ token: "abc", tokenExpiresAt: "2100-01-01T00:00:00.000Z" } as any);
        expect(vault.getToken()).toBe("abc");
        expect(vault.getToken(Date.parse("2200-01-01T00:00:00.000Z"))).toBeNull();
    });

    it("clears", () => {
        vault.set({ token: "abc", tokenExpiresAt: "2100-01-01T00:00:00.000Z" } as any);
        vault.clear();
        expect(vault.getToken()).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit src/main/buteco/pairing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement pairing.ts**

Create `src/main/buteco/pairing.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import { BUTECO_PROTOCOL } from "shared/buteco";
import type { ButecoResult, ButecoSession } from "shared/buteco";

import { groundRequest } from "./ground";

const EXCHANGE_PATH = "/api/compartilhagram/pairing/exchange";

/** Uppercases and strips separators; returns null for obviously invalid codes. */
export function normalizePairingCode(raw: string): string | null {
    const code = raw.replace(/[\s-]/g, "").toUpperCase();
    if (!code || !/^[A-Z0-9]+$/.test(code)) return null;
    return code;
}

function clientInfo() {
    return {
        app: "buteco-share",
        version: app.getVersion(),
        os: process.platform,
        osVersion: process.getSystemVersion?.() ?? "",
        protocol: BUTECO_PROTOCOL,
        capabilities: { appAudio: false, mic: true, maxHeight: 1440, maxFps: 60 }
    };
}

export async function exchangeCode(
    rawCode: string,
    fetchImpl?: typeof fetch
): Promise<ButecoResult<ButecoSession>> {
    const code = normalizePairingCode(rawCode);
    if (!code) {
        return { ok: false, error: { code: "invalid_code_format", message: "Código de pareamento inválido." } };
    }
    return groundRequest<ButecoSession>(EXCHANGE_PATH, {
        method: "POST",
        body: { code, client: clientInfo() },
        fetchImpl
    });
}

export interface TokenVault {
    set(session: ButecoSession): void;
    getToken(now?: number): string | null;
    getSession(): ButecoSession | null;
    clear(): void;
}

export function createTokenVault(): TokenVault {
    let session: ButecoSession | null = null;
    let expiresAt: number | null = null;

    return {
        set(value) {
            session = value;
            const t = Date.parse(value.tokenExpiresAt);
            expiresAt = Number.isFinite(t) ? t : null;
        },
        getToken(now = Date.now()) {
            if (session && expiresAt !== null && now >= expiresAt) session = null;
            return session?.token ?? null;
        },
        getSession() {
            return session;
        },
        clear() {
            session = null;
            expiresAt = null;
        }
    };
}

export const tokenVault = createTokenVault();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit src/main/buteco/pairing.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/buteco/pairing.ts src/main/buteco/pairing.test.ts
git commit -m "feat(buteco): pairing exchange and token vault"
```

---

## Task 4: Main — whip.ts (publish with busy retry)

**Files:**
- Create: `src/main/buteco/whip.ts`
- Test: `src/main/buteco/whip.test.ts`

**Interfaces:**
- Consumes: `groundRequest` (Task 2), `ButecoPublishMeta`, `ButecoPublishResult`, `ButecoResult`, `ButecoIceServer`.
- Produces: `publishScreen(req): Promise<ButecoResult<ButecoPublishResult>>`; `unpublishScreen()`; `refreshIce(): Promise<ButecoResult<ButecoIceServer[]>>`; `unpair()`; each accepting `deps = { token, fetchImpl?, sleep? }`.

- [ ] **Step 1: Write the failing test**

Create `src/main/buteco/whip.test.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { publishScreen } from "./whip";

const meta = {
    videoKind: "screen",
    videoLabel: "Monitor 1",
    audioLabel: null,
    mic: false,
    height: 1080,
    fps: 30
} as const;

function fetchReturns(...responses: Array<{ status: number; body: any }>) {
    let i = 0;
    return vi.fn(async () => {
        const r = responses[Math.min(i++, responses.length - 1)];
        return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
}

describe("publishScreen", () => {
    it("returns answer sdp and streamId", async () => {
        const fetchImpl = fetchReturns({ status: 200, body: { sdp: "v=0 answer", streamId: "s1" } });
        const res = await publishScreen({ token: "t", offerSdp: "v=0 offer", meta, fetchImpl });
        expect(res).toEqual({ ok: true, value: { sdp: "v=0 answer", streamId: "s1" } });
    });

    it("retries busy then succeeds", async () => {
        const fetchImpl = fetchReturns(
            { status: 409, body: { error: "busy" } },
            { status: 200, body: { sdp: "v=0 answer", streamId: "s1" } }
        );
        const sleep = vi.fn(async () => {});
        const res = await publishScreen({ token: "t", offerSdp: "v=0 offer", meta, fetchImpl, sleep });
        expect(res.ok).toBe(true);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    it("gives up after retries with sfu_unavailable", async () => {
        const fetchImpl = fetchReturns({ status: 409, body: { error: "busy" } });
        const sleep = vi.fn(async () => {});
        const res = await publishScreen({ token: "t", offerSdp: "v=0 offer", meta, fetchImpl, sleep });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("sfu_unavailable");
    });

    it("rejects a malformed 200 response", async () => {
        const fetchImpl = fetchReturns({ status: 200, body: { nope: 1 } });
        const res = await publishScreen({ token: "t", offerSdp: "v=0 offer", meta, fetchImpl });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("sfu_unavailable");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit src/main/buteco/whip.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement whip.ts**

Create `src/main/buteco/whip.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit src/main/buteco/whip.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/buteco/whip.ts src/main/buteco/whip.test.ts
git commit -m "feat(buteco): WHIP publish/unpublish/ice with busy retry"
```

---

## Task 5: Main — socket.ts (/helper client)

**Files:**
- Create: `src/main/buteco/socket.ts`
- Test: `src/main/buteco/socket.test.ts`

**Interfaces:**
- Consumes: `ButecoEvent`, `ButecoPhase`.
- Produces: `connectHelper(opts)` where `opts = { url, token, ioImpl?, onEvent }`; returns `{ sendStatus(phase, now?), close() }`. Injectable `ioImpl` for tests.

- [ ] **Step 1: Write the failing test**

Create `src/main/buteco/socket.test.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { connectHelper } from "./socket";

function fakeIo() {
    const handlers = new Map<string, Function>();
    const emitted: Array<[string, unknown]> = [];
    const socket = {
        connected: true,
        io: { on: vi.fn() },
        on: (ev: string, cb: Function) => { handlers.set(ev, cb); },
        emit: (ev: string, payload?: unknown) => { emitted.push([ev, payload]); },
        disconnect: vi.fn(),
        fire: (ev: string, payload?: unknown) => handlers.get(ev)?.(payload)
    };
    const io = vi.fn(() => socket) as any;
    return { io, socket, emitted };
}

describe("connectHelper", () => {
    it("connects to the namespace with auth and protocol", () => {
        const { io } = fakeIo();
        connectHelper({ url: "https://g/", token: "t", ioImpl: io, onEvent: () => {} });
        expect(io).toHaveBeenCalledWith("https://g/helper", expect.objectContaining({
            auth: { token: "t", protocol: 1 },
            transports: ["websocket"]
        }));
    });

    it("emits status at most once per second", () => {
        const { io, socket, emitted } = fakeIo();
        const ctrl = connectHelper({ url: "https://g", token: "t", ioImpl: io, onEvent: () => {} });
        socket.fire("connect");
        expect(ctrl.sendStatus("live", 1000)).toBe(true);
        expect(ctrl.sendStatus("live", 1500)).toBe(false);
        expect(emitted.filter(([e]) => e === "helper:status").length).toBe(1);
    });

    it("forwards session/revoked events", () => {
        const { io, socket } = fakeIo();
        const events: any[] = [];
        connectHelper({ url: "https://g", token: "t", ioImpl: io, onEvent: e => events.push(e) });
        socket.fire("connect");
        socket.fire("helper:revoked", { reason: "user_revoked" });
        socket.fire("helper:stop_requested", { by: "owner" });
        expect(events).toEqual([
            { type: "connection", state: "connected" },
            { type: "revoked", reason: "user_revoked" },
            { type: "stop_requested", by: "owner" }
        ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit src/main/buteco/socket.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement socket.ts**

Create `src/main/buteco/socket.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { io as defaultIo } from "socket.io-client";
import { BUTECO_PROTOCOL } from "shared/buteco";
import type { ButecoEvent, ButecoPhase } from "shared/buteco";

const STATUS_MIN_INTERVAL_MS = 1000;

export interface ConnectHelperOptions {
    url: string;
    token: string;
    ioImpl?: typeof defaultIo;
    onEvent: (event: ButecoEvent) => void;
}

export interface HelperConnection {
    sendStatus(phase: ButecoPhase, now?: number): boolean;
    close(): void;
}

export function connectHelper(opts: ConnectHelperOptions): HelperConnection {
    const ioImpl = opts.ioImpl ?? defaultIo;
    const socket = ioImpl(`${opts.url.replace(/\/$/, "")}/helper`, {
        path: "/socket.io",
        auth: { token: opts.token, protocol: BUTECO_PROTOCOL },
        transports: ["websocket"],
        reconnection: true,
        reconnectionDelayMax: 10_000
    });

    let closed = false;
    let lastStatusAt = Number.NEGATIVE_INFINITY;
    let pending: ButecoPhase | null = null;

    const emitStatus = (phase: ButecoPhase, now: number) => {
        lastStatusAt = now;
        socket.emit("helper:status", phase);
    };

    socket.on("connect", () => {
        opts.onEvent({ type: "connection", state: "connected" });
        if (pending) {
            emitStatus(pending, Date.now());
            pending = null;
        }
    });

    socket.on("disconnect", (reason: string) => {
        if (closed || reason === "io client disconnect") return;
        opts.onEvent({ type: "connection", state: reason === "io server disconnect" ? "offline" : "reconnecting" });
    });

    socket.io.on("reconnect_failed", () => opts.onEvent({ type: "connection", state: "offline" }));

    socket.on("connect_error", (err: Error) => {
        if (err.message === "token_invalid" || err.message === "client_outdated") {
            closed = true;
            socket.disconnect();
            opts.onEvent({ type: "connection", state: "offline" });
        }
    });

    socket.on("helper:session", (p: any) => {
        if (p?.room) opts.onEvent({ type: "session", session: p });
    });
    socket.on("helper:revoked", (p: any) => {
        if (p?.reason) opts.onEvent({ type: "revoked", reason: p.reason });
    });
    socket.on("helper:stop_requested", (p: any) => {
        if (p?.by) opts.onEvent({ type: "stop_requested", by: p.by });
    });
    socket.on("helper:screen_lost", (p: any) => {
        if (p?.reason) opts.onEvent({ type: "screen_lost", reason: p.reason });
    });

    return {
        sendStatus(phase, now = Date.now()) {
            if (closed) return false;
            if (!socket.connected) {
                pending = phase;
                return false;
            }
            if (now - lastStatusAt < STATUS_MIN_INTERVAL_MS) return false;
            emitStatus(phase, now);
            return true;
        },
        close() {
            closed = true;
            socket.disconnect();
        }
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit src/main/buteco/socket.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/buteco/socket.ts src/main/buteco/socket.test.ts
git commit -m "feat(buteco): helper socket.io client with status throttle"
```

---

## Task 6: Main — store, IPC events, VesktopNative.buteco

**Files:**
- Create: `src/main/buteco/store.ts`
- Create: `src/main/buteco/index.ts`
- Modify: `src/shared/IpcEvents.ts`
- Modify: `src/preload/VesktopNative.ts`
- Modify: `src/main/main.ts`
- Test: `src/main/buteco/store.test.ts`

**Interfaces:**
- Consumes: all Task 2–5 modules, `IpcEvents`.
- Produces: `butecoStore` (`getState()`, `setPhase`, `setSession`, `clear`, `onEvent(cb)`); `registerButeco()`; `VesktopNative.buteco.*`.

- [ ] **Step 1: Add IPC events**

Modify `src/shared/IpcEvents.ts` — add before the closing brace of `IpcEvents`:
```ts
    BUTECO_PAIR = "VCD_BUTECO_PAIR",
    BUTECO_UNPAIR = "VCD_BUTECO_UNPAIR",
    BUTECO_ARM_CAPTURE = "VCD_BUTECO_ARM_CAPTURE",
    BUTECO_CANCEL_CAPTURE = "VCD_BUTECO_CANCEL_CAPTURE",
    BUTECO_LIST_SOURCES = "VCD_BUTECO_LIST_SOURCES",
    BUTECO_PUBLISH = "VCD_BUTECO_PUBLISH",
    BUTECO_UNPUBLISH = "VCD_BUTECO_UNPUBLISH",
    BUTECO_REFRESH_ICE = "VCD_BUTECO_REFRESH_ICE",
    BUTECO_EVENT = "VCD_BUTECO_EVENT",
```

- [ ] **Step 2: Write the failing test for store**

Create `src/main/buteco/store.test.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { createButecoStore } from "./store";

describe("butecoStore", () => {
    it("tracks phase and session", () => {
        const store = createButecoStore();
        expect(store.getState().phase).toBe("idle");
        store.setPhase("live");
        expect(store.getState().phase).toBe("live");
    });

    it("forwards events to subscribers", () => {
        const store = createButecoStore();
        const cb = vi.fn();
        store.onEvent(cb);
        store.emitEvent({ type: "revoked", reason: "user_revoked" });
        expect(cb).toHaveBeenCalledWith({ type: "revoked", reason: "user_revoked" });
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:unit src/main/buteco/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement store.ts**

Create `src/main/buteco/store.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoEvent, ButecoPhase, ButecoSession } from "shared/buteco";

export interface ButecoState {
    phase: ButecoPhase;
    session: ButecoSession | null;
    publishing: boolean;
}

export interface ButecoStore {
    getState(): ButecoState;
    setPhase(phase: ButecoPhase): void;
    setSession(session: ButecoSession | null): void;
    setPublishing(value: boolean): void;
    emitEvent(event: ButecoEvent): void;
    onEvent(cb: (event: ButecoEvent) => void): () => void;
    clear(): void;
}

export function createButecoStore(): ButecoStore {
    let state: ButecoState = { phase: "idle", session: null, publishing: false };
    const listeners = new Set<(event: ButecoEvent) => void>();

    return {
        getState: () => state,
        setPhase: phase => (state = { ...state, phase }),
        setSession: session => (state = { ...state, session }),
        setPublishing: publishing => (state = { ...state, publishing }),
        emitEvent: event => listeners.forEach(cb => cb(event)),
        onEvent(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        clear: () => (state = { phase: "idle", session: null, publishing: false })
    };
}

export const butecoStore = createButecoStore();
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:unit src/main/buteco/store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Implement main/buteco/index.ts**

Create `src/main/buteco/index.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { desktopCapturer, webContents } from "electron";
import { IpcEvents } from "shared/IpcEvents";
import type { ButecoPublishMeta, ButecoSource } from "shared/buteco";

import { mainWin } from "../mainWindow";
import { handle } from "../utils/ipcWrappers";
import { armCapture, cancelCapture } from "./capture";
import { exchangeCode, tokenVault } from "./pairing";
import { connectHelper, type HelperConnection } from "./socket";
import { butecoStore } from "./store";
import { publishScreen, refreshIce, unpair, unpublishScreen } from "./whip";

let helper: HelperConnection | null = null;

function broadcast() {
    for (const wc of webContents.getAllWebContents()) {
        wc.send(IpcEvents.BUTECO_EVENT, butecoStore.getState());
    }
}

function connectSocket() {
    helper?.close();
    const session = tokenVault.getSession();
    if (!session) return;

    helper = connectHelper({
        url: session.socket.url,
        token: session.token,
        onEvent: event => {
            butecoStore.emitEvent(event);
            if (event.type === "revoked" || event.type === "stop_requested" || event.type === "screen_lost") {
                butecoStore.setPublishing(false);
                butecoStore.setPhase("idle");
            }
            broadcast();
        }
    });
}

export function registerButeco() {
    handle(IpcEvents.BUTECO_PAIR, async (_, code: string) => {
        butecoStore.setPhase("pairing");
        const res = await exchangeCode(code);
        if (res.ok) {
            tokenVault.set(res.value);
            butecoStore.setSession(res.value);
            butecoStore.setPhase("ready");
            connectSocket();
        } else {
            butecoStore.setPhase("idle");
        }
        broadcast();
        return res;
    });

    handle(IpcEvents.BUTECO_UNPAIR, async () => {
        const token = tokenVault.getToken();
        helper?.close();
        helper = null;
        if (token) await unpair({ token });
        tokenVault.clear();
        butecoStore.clear();
        broadcast();
        return { ok: true, value: undefined };
    });

    handle(IpcEvents.BUTECO_ARM_CAPTURE, (_, sourceId: string) => armCapture(sourceId));
    handle(IpcEvents.BUTECO_CANCEL_CAPTURE, () => cancelCapture());

    handle(IpcEvents.BUTECO_LIST_SOURCES, async (): Promise<ButecoSource[]> => {
        const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 320, height: 180 }
        });
        return sources.map(s => ({
            id: s.id,
            name: s.name,
            kind: s.id.startsWith("screen:") ? "screen" : "window",
            thumbnailDataUrl: s.thumbnail.isEmpty() ? undefined : s.thumbnail.toDataURL()
        }));
    });

    handle(IpcEvents.BUTECO_PUBLISH, async (_, offerSdp: string, meta: ButecoPublishMeta) => {
        const token = tokenVault.getToken();
        if (!token) return { ok: false, error: { code: "token_invalid", message: "Sem sessão." } };
        butecoStore.setPhase("starting");
        const res = await publishScreen({ token, offerSdp, meta });
        if (res.ok) {
            butecoStore.setPublishing(true);
            butecoStore.setPhase("live");
        } else {
            butecoStore.setPublishing(false);
            butecoStore.setPhase("idle");
        }
        broadcast();
        return res;
    });

    handle(IpcEvents.BUTECO_UNPUBLISH, async () => {
        const token = tokenVault.getToken();
        butecoStore.setPhase("stopping");
        const res = token ? await unpublishScreen({ token }) : ({ ok: true, value: undefined } as const);
        butecoStore.setPublishing(false);
        butecoStore.setPhase("idle");
        broadcast();
        return res;
    });

    handle(IpcEvents.BUTECO_REFRESH_ICE, async () => {
        const token = tokenVault.getToken();
        if (!token) return { ok: false, error: { code: "token_invalid", message: "Sem sessão." } };
        return refreshIce({ token });
    });
}

export { butecoStore, mainWin };
```

- [ ] **Step 7: Expose VesktopNative.buteco**

Modify `src/preload/VesktopNative.ts` — add to the exported object (after `capturer`):
```ts
    buteco: {
        pair: (code: string) => invoke(IpcEvents.BUTECO_PAIR, code),
        unpair: () => invoke(IpcEvents.BUTECO_UNPAIR),
        armCapture: (sourceId: string) => invoke(IpcEvents.BUTECO_ARM_CAPTURE, sourceId),
        cancelCapture: () => invoke(IpcEvents.BUTECO_CANCEL_CAPTURE),
        listSources: () => invoke(IpcEvents.BUTECO_LIST_SOURCES),
        publish: (offerSdp: string, meta: unknown) => invoke(IpcEvents.BUTECO_PUBLISH, offerSdp, meta),
        unpublish: () => invoke(IpcEvents.BUTECO_UNPUBLISH),
        refreshIce: () => invoke(IpcEvents.BUTECO_REFRESH_ICE),
        onEvent: (cb: (state: unknown) => void) => {
            ipcRenderer.on(IpcEvents.BUTECO_EVENT, (_e, state) => cb(state));
        }
    },
```

- [ ] **Step 8: Register in main**

Modify `src/main/main.ts` — import and call in `app.whenReady().then(...)`, after `registerScreenShareHandler()`:
```ts
import { registerButeco } from "./buteco";
...
        registerScreenShareHandler();
        registerButeco();
        registerMediaPermissionsHandler();
```

- [ ] **Step 9: Typecheck**

Run: `pnpm testTypes`
Expected: PASS (no errors).

- [ ] **Step 10: Commit**

```bash
git add src/shared/IpcEvents.ts src/main/buteco/store.ts src/main/buteco/store.test.ts src/main/buteco/index.ts src/preload/VesktopNative.ts src/main/main.ts
git commit -m "feat(buteco): main store, IPC registration and VesktopNative.buteco"
```

---

## Task 7: Main — capture.ts (armed capture, single-use + TTL)

**Files:**
- Create: `src/main/buteco/capture.ts`
- Test: `src/main/buteco/capture.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `armCapture(sourceId)`, `cancelCapture()`, `consumeCapture(now?)`, `peekCapture()`, `CAPTURE_TTL_MS`.

- [ ] **Step 1: Write the failing test**

Create `src/main/buteco/capture.test.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it } from "vitest";

import { armCapture, CAPTURE_TTL_MS, cancelCapture, consumeCapture, peekCapture } from "./capture";

describe("armed capture", () => {
    beforeEach(() => cancelCapture());

    it("returns null when nothing armed", () => {
        expect(consumeCapture()).toBeNull();
    });

    it("consumes once", () => {
        armCapture("screen:1");
        expect(peekCapture()).toBe("screen:1");
        expect(consumeCapture()).toBe("screen:1");
        expect(consumeCapture()).toBeNull();
    });

    it("expires after TTL", () => {
        armCapture("screen:1");
        expect(consumeCapture(Date.now() + CAPTURE_TTL_MS + 1)).toBeNull();
    });

    it("cancel clears", () => {
        armCapture("screen:1");
        cancelCapture();
        expect(consumeCapture()).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit src/main/buteco/capture.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement capture.ts**

Create `src/main/buteco/capture.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const CAPTURE_TTL_MS = 10_000;

let armed: { sourceId: string; armedAt: number } | null = null;

export function armCapture(sourceId: string) {
    armed = { sourceId, armedAt: Date.now() };
}

export function cancelCapture() {
    armed = null;
}

export function peekCapture(): string | null {
    return armed?.sourceId ?? null;
}

/** Single-use: returns the armed source id and clears it. */
export function consumeCapture(now = Date.now()): string | null {
    if (!armed) return null;
    if (now - armed.armedAt > CAPTURE_TTL_MS) {
        armed = null;
        return null;
    }
    const id = armed.sourceId;
    armed = null;
    return id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit src/main/buteco/capture.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/buteco/capture.ts src/main/buteco/capture.test.ts
git commit -m "feat(buteco): single-use armed capture with TTL"
```

---

## Task 8: Main — screenShare hook (armed capture + Buteco cancel)

**Files:**
- Modify: `src/main/screenShare.ts`
- Modify: `src/renderer/components/ScreenSharePicker.tsx` (add `mode` to `StreamPick` type only)

**Interfaces:**
- Consumes: `consumeCapture` (Task 7), `StreamPick.mode`.
- Produces: the display-media handler honours armed captures and cancels the Go Live when `mode === "buteco"`.

**Note:** No unit test (Electron handler). Verified at integration (Task 11). Keep the diff tiny.

- [ ] **Step 1: Extend StreamPick with mode**

Modify `src/renderer/components/ScreenSharePicker.tsx` — add `mode?: "native" | "buteco"` to the `StreamPick` interface:
```ts
export interface StreamPick extends StreamSettings {
    id: string;
    mode?: "native" | "buteco";
}
```

- [ ] **Step 2: Hook the handler**

Modify `src/main/screenShare.ts`:
- Add import: `import { consumeCapture } from "./buteco/capture";`
- At the very start of the `setDisplayMediaRequestHandler` callback, before building sources:
```ts
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
        // Buteco: the module's own getDisplayMedia call consumes the armed source; never reopen the picker.
        const armedId = consumeCapture();
        if (armedId) {
            const sources = await desktopCapturer.getSources({ types: ["window", "screen"] }).catch(() => []);
            const source = sources.find(s => s.id === armedId);
            callback(source ? { video: source } : {});
            return;
        }
```
- After `const choice = await sendRendererCommand<StreamPick>(...)` and the `if (!choice) return callback({});`, add:
```ts
        if (choice.mode === "buteco") {
            // Handled by the Buteco module; do not send media to Discord's SFU.
            callback({});
            return;
        }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm testTypes`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/screenShare.ts src/renderer/components/ScreenSharePicker.tsx
git commit -m "feat(buteco): armed capture + Go Live diversion in screenshare handler"
```

---

## Task 9: Renderer — settings + toggle in the picker

**Files:**
- Modify: `src/shared/settings.d.ts`
- Modify: `src/shared/defaultSettings.ts`
- Modify: `src/renderer/components/ScreenSharePicker.tsx`

**Interfaces:**
- Consumes: `useSettings` (Task context), `StreamPick.mode`.
- Produces: a `Native | Buteco Games` toggle at the top of the picker; persists `Settings.butecoMode`. When Buteco is selected, `ModalComponent` renders `<ButecoPanel />` instead of the source grid and resolves `{ id: "", mode: "buteco", ... }` on Iniciar.

- [ ] **Step 1: Add the setting**

Modify `src/shared/settings.d.ts` — add to `Settings`:
```ts
    butecoMode?: "native" | "buteco";
```
Modify `src/shared/defaultSettings.ts` — add `butecoMode: "native",` inside the default object (match the existing formatting).

- [ ] **Step 2: Add the toggle + branch**

Modify `src/renderer/components/ScreenSharePicker.tsx`:
- Import the panel: `import { ButecoPanel } from "renderer/buteco/ButecoPanel";`
- In `ModalComponent`, add a toggle row above the body. Use `useSettings()`:
```tsx
    const Settings = useSettings();
    const mode = Settings.butecoMode ?? "native";

    const [butecoPick, setButecoPick] = useState<ButecoPick | null>(null);
```
where (declare near the top of the file):
```ts
export interface ButecoPick {
    sourceId: string;
    videoKind: "screen" | "window";
    videoLabel: string;
    height: 720 | 1080 | 1440;
    fps: 30 | 60;
    mic: boolean;
    includeSources?: AudioSources;
}
```
- Render the toggle at the top of the modal body:
```tsx
            <div className={cl("mode-toggle")}>
                {(["native", "buteco"] as const).map(m => (
                    <button
                        key={m}
                        className={cl("mode-option")}
                        data-selected={mode === m}
                        onClick={() => (Settings.butecoMode = m)}
                    >
                        {m === "native" ? "Native" : "Buteco Games"}
                    </button>
                ))}
            </div>
```
- Branch the body:
```tsx
            {mode === "buteco" ? (
                <ButecoPanel
                    pick={butecoPick}
                    onPick={setButecoPick}
                    onStart={() => {
                        submit({ id: "", mode: "buteco", contentHint: settings.contentHint, audio: settings.audio } as StreamPick);
                        close();
                    }}
                />
            ) : !selected ? (
                <ScreenPicker screens={screens} chooseScreen={setSelected} />
            ) : (
                <StreamSettingsUi ... />
            )}
```
- In `handleGoLive`, when `mode === "buteco"` skip the Discord-connection constraint code (it is harmless, but guard for clarity).

- [ ] **Step 3: Typecheck**

Run: `pnpm testTypes`
Expected: FAIL until `ButecoPanel` exists (Task 10 creates it). For this task, create a minimal stub now and flesh it out in Task 10:
`src/renderer/buteco/ButecoPanel.tsx`:
```tsx
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { AudioSources, ButecoPick } from "renderer/components/ScreenSharePicker";

export function ButecoPanel(_props: {
    pick: ButecoPick | null;
    onPick: (p: ButecoPick) => void;
    onStart: () => void;
}) {
    return <div>Buteco</div>;
}
```
Then re-run `pnpm testTypes` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared/settings.d.ts src/shared/defaultSettings.ts src/renderer/components/ScreenSharePicker.tsx src/renderer/buteco/ButecoPanel.tsx
git commit -m "feat(buteco): Native|Buteco toggle in the screen share picker"
```

---

## Task 10: Renderer — controller.ts (WebRTC + audio)

**Files:**
- Create: `src/renderer/buteco/controller.ts`
- Test: `src/renderer/buteco/controller.test.ts`

**Interfaces:**
- Consumes: `ButecoSession`, `ButecoPublishMeta`, `ButecoPublishResult`, `ButecoResult`, `ButecoIceServer`.
- Produces: `createButecoController(deps)` where `deps` mirrors the real APIs:
```ts
interface ControllerDeps {
    getSession(): ButecoSession | null;
    getDisplayMedia(opts: MediaStreamConstraints): Promise<MediaStream>;
    getUserMedia(opts: MediaStreamConstraints): Promise<MediaStream>;
    createPeerConnection(iceServers: ButecoIceServer[]): RTCPeerConnection;
    publish(sdp: string, meta: ButecoPublishMeta): Promise<ButecoResult<ButecoPublishResult>>;
    unpublish(): Promise<ButecoResult<void>>;
    getVirtmicDeviceId?(): Promise<string | null>;
    virtmic?: { start(nodes: unknown[]): Promise<void>; stop(): Promise<void> };
}
```
Returns `{ start(opts: StartOptions): Promise<ButecoResult<void>>; stop(): Promise<void>; getConnection(): RTCPeerConnection | null }`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/buteco/controller.test.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { createButecoController } from "./controller";

function fakeStream(id: string) {
    const track = { id, kind: id.startsWith("aud") ? "audio" : "video", contentHint: "", stop: vi.fn(), addEventListener: vi.fn() };
    return { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [track] } as any;
}

function fakePC() {
    const pc: any = {
        addedTransceivers: [] as any[],
        localDescription: { sdp: "v=0 offer" },
        addTransceiver: vi.fn((track: any, init: any) => {
            const sender = { setCodecPreferences: vi.fn() };
            pc.addedTransceivers.push({ init });
            return { sender };
        }),
        createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0 offer" })),
        setLocalDescription: vi.fn(async () => {}),
        setRemoteDescription: vi.fn(async () => {}),
        close: vi.fn()
    };
    return pc;
}

const session = {
    token: "t",
    room: { id: "r", slug: "r", name: "r" },
    iceServers: [],
    limits: { screenAudioAllowed: true, maxHeight: 1080, maxFps: 30, maxVideoKbps: 1, audioKbps: 1 },
    socket: { url: "wss://g", path: "/socket.io", namespace: "/helper" }
} as any;

describe("ButecoController", () => {
    it("publishes a video-only sendonly transceiver and applies the answer", async () => {
        const pc = fakePC();
        const publish = vi.fn(async () => ({ ok: true, value: { sdp: "v=0 answer", streamId: "s1" } }));
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => fakeStream("vid1"),
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish,
            unpublish: async () => ({ ok: true, value: undefined })
        });

        const res = await c.start({ sourceId: "", videoKind: "screen", videoLabel: "M", height: 1080, fps: 30, mic: false });
        expect(res.ok).toBe(true);
        expect(pc.addedTransceivers[0].init.direction).toBe("sendonly");
        expect(publish).toHaveBeenCalledWith("v=0 offer", expect.objectContaining({ height: 1080, fps: 30, mic: false }));
        expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "v=0 answer" });
        expect(pc.addedTransceivers).toHaveLength(1);
    });

    it("adds an audio transceiver when mic is on and limits allow", async () => {
        const pc = fakePC();
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => fakeStream("vid1"),
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish: async () => ({ ok: true, value: { sdp: "v=0 answer", streamId: "s1" } }),
            unpublish: async () => ({ ok: true, value: undefined })
        });
        await c.start({ sourceId: "", videoKind: "screen", videoLabel: "M", height: 1080, fps: 30, mic: true });
        expect(pc.addedTransceivers).toHaveLength(2);
    });

    it("stops tracks and unpublishes", async () => {
        const pc = fakePC();
        const unpublish = vi.fn(async () => ({ ok: true, value: undefined }));
        const stream = fakeStream("vid1");
        const c = createButecoController({
            getSession: () => session,
            getDisplayMedia: async () => stream,
            getUserMedia: async () => fakeStream("aud1"),
            createPeerConnection: () => pc,
            publish: async () => ({ ok: true, value: { sdp: "v=0 answer", streamId: "s1" } }),
            unpublish
        });
        await c.start({ sourceId: "", videoKind: "screen", videoLabel: "M", height: 1080, fps: 30, mic: false });
        await c.stop();
        expect(stream.getTracks()[0].stop).toHaveBeenCalled();
        expect(pc.close).toHaveBeenCalled();
        expect(unpublish).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit src/renderer/buteco/controller.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement controller.ts**

Create `src/renderer/buteco/controller.ts`:
```ts
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
    ButecoIceServer,
    ButecoPublishMeta,
    ButecoPublishResult,
    ButecoResult,
    ButecoSession
} from "shared/buteco";

export interface StartOptions {
    sourceId: string;
    videoKind: "screen" | "window";
    videoLabel: string;
    height: 720 | 1080 | 1440;
    fps: 30 | 60;
    mic: boolean;
    audioLabel?: string | null;
    includeAudioNodes?: unknown[];
}

export interface ControllerDeps {
    getSession(): ButecoSession | null;
    getDisplayMedia(opts: MediaStreamConstraints): Promise<MediaStream>;
    getUserMedia(opts: MediaStreamConstraints): Promise<MediaStream>;
    createPeerConnection(iceServers: ButecoIceServer[]): RTCPeerConnection;
    publish(sdp: string, meta: ButecoPublishMeta): Promise<ButecoResult<ButecoPublishResult>>;
    unpublish(): Promise<ButecoResult<void>>;
    getVirtmicDeviceId?(): Promise<string | null>;
    virtmic?: { start(nodes: unknown[]): Promise<void>; stop(): Promise<void> };
}

export interface ButecoController {
    start(opts: StartOptions): Promise<ButecoResult<void>>;
    stop(): Promise<void>;
    getConnection(): RTCPeerConnection | null;
}

const VIRT_MIC_LABEL = "vencord-screen-share";

export function createButecoController(deps: ControllerDeps): ButecoController {
    let pc: RTCPeerConnection | null = null;
    const streams: MediaStream[] = [];
    let usingVirtmic = false;

    async function stop() {
        streams.forEach(s => s.getTracks().forEach(t => t.stop()));
        streams.length = 0;
        pc?.close();
        pc = null;
        if (usingVirtmic) {
            usingVirtmic = false;
            await deps.virtmic?.stop().catch(() => {});
        }
        await deps.unpublish().catch(() => {});
    }

    async function start(opts: StartOptions): Promise<ButecoResult<void>> {
        const session = deps.getSession();
        if (!session) return { ok: false, error: { code: "token_invalid", message: "Sem sessão." } };

        const display = await deps.getDisplayMedia({ video: true, audio: false });
        streams.push(display);
        const videoTrack = display.getVideoTracks()[0];
        if (!videoTrack) {
            await stop();
            return { ok: false, error: { code: "video_capture_failed", message: "Sem vídeo." } };
        }
        videoTrack.contentHint = "motion";

        pc = deps.createPeerConnection(session.iceServers);
        const sender = pc.addTransceiver(videoTrack, { direction: "sendonly", streams: [display] }).sender;
        const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs;
        if (codecs?.length && sender.setCodecPreferences) {
            const preferred = codecs.filter(c => /H264|VP8/i.test(c.mimeType));
            if (preferred.length) sender.setCodecPreferences(preferred);
        }

        const audioAllowed = session.limits.screenAudioAllowed;
        let audioLabel: string | null = null;
        let micEnabled = false;

        if (audioAllowed && opts.mic) {
            const mic = await deps.getUserMedia({ audio: true, video: false });
            streams.push(mic);
            pc.addTransceiver(mic.getAudioTracks()[0], { direction: "sendonly", streams: [mic] });
            micEnabled = true;
        }

        if (audioAllowed && opts.includeAudioNodes?.length && deps.virtmic) {
            await deps.virtmic.start(opts.includeAudioNodes);
            usingVirtmic = true;
            const devId = (await deps.getVirtmicDeviceId?.()) ?? VIRT_MIC_LABEL;
            const appAudio = await deps.getUserMedia({
                audio: { deviceId: { exact: devId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
                video: false
            });
            streams.push(appAudio);
            pc.addTransceiver(appAudio.getAudioTracks()[0], { direction: "sendonly", streams: [appAudio] });
            audioLabel = opts.audioLabel ?? VIRT_MIC_LABEL;
        }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const sdp = pc.localDescription?.sdp ?? offer.sdp;
        if (!sdp) {
            await stop();
            return { ok: false, error: { code: "video_capture_failed", message: "Falha ao preparar SDP." } };
        }

        const meta: ButecoPublishMeta = {
            videoKind: opts.videoKind,
            videoLabel: opts.videoLabel,
            audioLabel,
            mic: micEnabled,
            height: opts.height,
            fps: opts.fps
        };

        const res = await deps.publish(sdp, meta);
        if (!res.ok) {
            await stop();
            return res;
        }

        await pc.setRemoteDescription({ type: "answer", sdp: res.value.sdp });
        return { ok: true, value: undefined };
    }

    return { start, stop, getConnection: () => pc };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit src/renderer/buteco/controller.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/buteco/controller.ts src/renderer/buteco/controller.test.ts
git commit -m "feat(buteco): renderer WebRTC controller with audio gating"
```

---

## Task 11: Renderer — wire the controller into the picker (start/stop)

**Files:**
- Modify: `src/renderer/buteco/ButecoPanel.tsx`
- Modify: `src/renderer/components/ScreenSharePicker.tsx`

**Interfaces:**
- Consumes: `createButecoController` (Task 10), `VesktopNative.buteco` (Task 6), `ButecoPick`.
- Produces: clicking Iniciar arms the capture, obtains the stream via `getDisplayMedia`, publishes, and subscribes to `onEvent` to stop on `revoked`/`stop_requested`/`screen_lost`.

- [ ] **Step 1: Implement the real ButecoPanel**

Replace `src/renderer/buteco/ButecoPanel.tsx`:
```tsx
/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, HeadingTertiary, Paragraph } from "@vencord/types/components";
import { useAwaiter } from "@vencord/types/utils";
import { useState } from "@vencord/types/webpack/common";
import type { ButecoSource } from "shared/buteco";
import type { ButecoPick } from "renderer/components/ScreenSharePicker";
import { useForceUpdater } from "@vencord/types/utils";

export function ButecoPanel({
    pick,
    onPick,
    onStart,
    paired,
    onPair
}: {
    pick: ButecoPick | null;
    onPick: (p: ButecoPick) => void;
    onStart: () => void;
    paired: boolean;
    onPair: (code: string) => Promise<boolean>;
}) {
    const [code, setCode] = useState("");
    const [, forceUpdate] = useForceUpdater();
    const [sources] = useAwaiter<ButecoSource[]>(() => VesktopNative.buteco.listSources(), {
        fallbackValue: [],
        deps: []
    });

    if (!paired) {
        return (
            <div>
                <HeadingTertiary>Conectar ao Buteco Games</HeadingTertiary>
                <Paragraph>Informe o código de pareamento exibido na sala do Buteco.</Paragraph>
                <input value={code} onChange={e => setCode(e.currentTarget.value)} placeholder="CÓDIGO" />
                <Button onClick={() => onPair(code)}>Parear</Button>
            </div>
        );
    }

    return (
        <div>
            <HeadingTertiary>Fonte</HeadingTertiary>
            <div>
                {sources.map(s => (
                    <button
                        key={s.id}
                        data-selected={pick?.sourceId === s.id}
                        onClick={() => {
                            onPick({
                                sourceId: s.id,
                                videoKind: s.kind,
                                videoLabel: s.name,
                                height: pick?.height ?? 1080,
                                fps: pick?.fps ?? 30,
                                mic: pick?.mic ?? true
                            });
                            forceUpdate();
                        }}
                    >
                        {s.thumbnailDataUrl ? <img src={s.thumbnailDataUrl} alt="" /> : null}
                        {s.name}
                    </button>
                ))}
            </div>
            <Button disabled={!pick} onClick={onStart}>
                Iniciar
            </Button>
        </div>
    );
}
```

- [ ] **Step 2: Wire pair + start in the picker**

In `src/renderer/components/ScreenSharePicker.tsx`:
- Add a `paired` state and a `pair` handler; call `VesktopNative.buteco.pair(code)` and check `res.ok`.
- Pass `paired`/`onPair` to `<ButecoPanel />`.
- In `onStart`, before `submit`, arm capture via `VesktopNative.buteco.cancelCapture()` then the module will call `getDisplayMedia` after the handler cancels the Go Live. Since the picker is what the handler is waiting on, order is: call `submit(...)` → `close()`; the main handler sees `mode: "buteco"` and `callback({})`. The controller `start` (Task 10) is invoked after the modal closes, from `openScreenSharePicker`'s resolution path.

Modify `openScreenSharePicker`'s `submit` wrapper:
```tsx
                    submit={async v => {
                        didSubmit = true;

                        if (v.mode === "buteco") {
                            await startButecoPublish(v as ButecoPick);
                            resolve(v);
                            return;
                        }

                        if (v.includeSources && v.includeSources !== "SpecialSource.None") {
                            // ...existing virtmic logic unchanged...
                        }
                        resolve(v);
                    }}
```
- Add `startButecoPublish` (module-scope) that:
  1. `await VesktopNative.buteco.armCapture(pick.sourceId)`
  2. builds the controller from `VesktopNative.buteco` + real `navigator.mediaDevices` + `new RTCPeerConnection`
  3. `await controller.start({...})`
  4. subscribes `VesktopNative.buteco.onEvent` and calls `controller.stop()` on `revoked`/`stop_requested`/`screen_lost`
  5. stores the controller in a module-level `let activeButecoController` so the native-UI stop (Task 14) can call it.

- [ ] **Step 3: Typecheck**

Run: `pnpm testTypes`
Expected: PASS.

- [ ] **Step 4: Manual integration check**

Run `pnpm start:dev`. In a call: Go Live → toggle "Buteco Games" → Parear (código real) → escolher fonte → Iniciar. Verify: Discord cancela o Go Live, o stream aparece na sala do Buteco, e Parar encerra.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/buteco/ButecoPanel.tsx src/renderer/components/ScreenSharePicker.tsx
git commit -m "feat(buteco): wire publish/stop into the picker"
```

---

## Task 12: Main — list-source thumbnails are already exposed; verify audio path

**Files:**
- Modify: `src/renderer/buteco/ButecoPanel.tsx`

**Interfaces:**
- Consumes: `VesktopNative.virtmic` (existing), `Settings.audio` (existing).
- Produces: app-audio source selection using the existing venmic list; passes `includeAudioNodes` + `audioLabel` to the controller.

- [ ] **Step 1: Add audio source selection**

In `ButecoPanel`, when `paired && pick`, add an audio block using `VesktopNative.virtmic.list()` (same shape as the Linux picker in `ScreenSharePicker.tsx`) and a checkbox "Compartilhar áudio do sistema". Store the selected nodes in `pick` (extend `ButecoPick` with `includeAudioNodes?: unknown[]`), and pass through to `controller.start`.

- [ ] **Step 2: Typecheck + manual check**

Run: `pnpm testTypes`
Expected: PASS.
Manual: with áudio do sistema ativo, confirmir que a trilha chega ao Buteco e que `virtmic.stop()` é chamado no fim.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/buteco/ButecoPanel.tsx src/renderer/components/ScreenSharePicker.tsx
git commit -m "feat(buteco): system audio via venmic"
```

---

## Task 13: Renderer — errors + panel polish

**Files:**
- Modify: `src/renderer/buteco/ButecoPanel.tsx`
- Modify: `src/renderer/components/ScreenSharePicker.tsx`

**Interfaces:**
- Consumes: `ButecoErrorCode` (Task 1).
- Produces: human-readable messages for `screen_taken`, `screen_audio_disabled`, `token_invalid`, `client_outdated`, `network`, `sfu_unavailable`; re-pairing prompt on `token_invalid`/`client_outdated`.

- [ ] **Step 1: Add the error map**

In `ButecoPanel.tsx` (or a small `messages.ts`):
```ts
import type { ButecoErrorCode } from "shared/buteco";

export const BUTECO_ERROR_MESSAGES: Record<ButecoErrorCode, string> = {
    invalid_code_format: "Código de pareamento inválido.",
    token_invalid: "Sessão expirada. Faça o pareamento novamente.",
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
```
Render `butecoStore`-driven errors (from `onEvent`) and publish errors in the panel.

- [ ] **Step 2: Typecheck + manual**

Run: `pnpm testTypes` → PASS. Manually force `screen_taken` (share from the browser first) and confirm the message.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/buteco/
git commit -m "feat(buteco): error messaging and panel polish"
```

---

## Task 14 (SPIKE): Renderer — emulate Discord stream state for native UI

**Files:**
- Create: `src/renderer/buteco/streamState.ts`
- Modify: `src/renderer/buteco/ButecoPanel.tsx` / picker

**Interfaces:**
- Consumes: Vencord webpack commons (`FluxDispatcher`, `StreamStore`/`MediaEngineStore` — locate exact names at spike time).
- Produces: a best-effort local stream state so Discord's native "live" indicator/panel and Parar appear without media reaching the SFU.

**Time box:** ≤ 1 day. If it cannot be made version-stable, stop and implement the fallback (Vesktop tray item "Parar compartilhamento Buteco" using the existing `src/main/tray.ts`).

- [ ] **Step 1: Recon**

Locate the Discord modules that drive the stream UI (`StreamStore`, `StreamActionCreators`, `MediaEngineStore.getMediaEngine().connections`) via DevTools/webpack. Record exact module finders and action shapes in this task before coding.

- [ ] **Step 2: Prototype**

Wrap `navigator.mediaDevices.getDisplayMedia` at module load: if Buteco mode is active, return a silent/placeholder `MediaStream` (canvas `captureStream` or a black track) so Discord's `Go Live` proceeds and shows native UI, while the real capture from the module publishes to the Buteco. `stop` on the placeholder stops the Buteco publish too.

> Note: this deliberately deviates from "nothing to Discord's SFU" (a placeholder reaches the SFU). The user accepted local state emulation; confirm at implementation which variant (placeholder vs state injection) is stable. If placeholder is required for the native UI, re-confirm scope before committing.

- [ ] **Step 3: Decide + record**

If viable: wire Parar to `activeButecoController.stop()`. If not viable: implement the tray fallback in `src/main/tray.ts` and stop here.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/buteco/ src/main/tray.ts
git commit -m "feat(buteco): native stream UI emulation (spike)"
```

---

## Self-Review

**Spec coverage:**
- Módulo Vesktop (Plan B) → Tasks 6, 8, 9, 11. ✓
- Toggle no picker + persistência → Task 9. ✓
- Captura armada single-use → Tasks 7, 8. ✓
- Rede (ground/pairing/socket/whip/store) → Tasks 2–6. ✓
- WebRTC sendonly h264/vp8 → Task 10. ✓
- Áudio mic + venmic gated → Tasks 10, 12. ✓
- Paridade (tela + áudio + socket + fonte/qualidade) → Tasks 2–6, 9–12. ✓
- Câmera fora → global constraint; nenhuma task a implementa. ✓
- UI nativa (mock) como spike + fallback → Task 14. ✓
- vitest + testes puros → Tasks 1–7, 10. ✓
- Erros mapeados → Tasks 1, 13. ✓

**Placeholder scan:** Task 14 é explicitamente um spike com recon antes de codar (justificado na spec como risco). Tasks 11/12/13 descrevem mudanças em React com pontos de integração nomeados, não passos vagos.

**Type consistency:** `ButecoPick` é declarado em `ScreenSharePicker.tsx` e importado por `ButecoPanel.tsx` (Task 9). `createButecoController`/`StartOptions` (Task 10) são consumidos na Task 11. `IpcEvents.BUTECO_*` (Task 6) usados no preload (Task 6) e no renderer (Tasks 11). `consumeCapture` (Task 7) usado no handler (Task 8). Nomes consistentes.

**Gap nota:** a Task 14 pode exigir revisão de escopo (placeholder no SFU). Isso está sinalizado dentro da própria task, não escondido.
