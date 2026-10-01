# Buteco Games Web — Sessão, Salas e Transmissão sem Código (Design)

Data: 2026-10-01
Status: implementado (Fase 1)
Relacionado: `docs/superpowers/specs/2026-10-01-buteco-games-vesktop-design.md` (Fase anterior: publicação via pairing code)

## Objetivo

Substituir o fluxo de **pairing code** do Buteco Games por uma **sessão web única**
(login no site `https://games.butecodosdevs.com`), e permitir **entrar em salas,
transmitir e (fase 2) assistir** sem passar código — seguindo exatamente o
protocolo que o próprio site usa (extraído do bundle de produção).

## Contexto

O Companion (AppImage) usa um helper próprio: código de pareamento → token Bearer →
endpoints `/api/compartilhagram/helper/*`. O site usa outra camada:

- Sessão **Better Auth** (cookie `__Secure-better-auth.session_token`).
- Socket.IO no namespace default do site, autenticado por **cookie**.
- REST sob `/api/compartilhagram/sfu/*` para WHIP/WHEP/close e `/api/rtc/ice` para ICE.

Como o site não exige código para quem está logado, essa camada elimina o
pareamento e ainda habilita o **viewer** (WHEP) — impossível pelo helper.

## Protocolo do site (extraído do bundle)

Origem: `https://games.butecodosdevs.com`. Sessão: cookie
`__Secure-better-auth.session_token` (Better Auth).

### Socket.IO

```js
io("https://games.butecodosdevs.com", {
    withCredentials: true,
    transports: ["websocket", "polling"]
});
```

| Direção | Evento | Payload |
|---|---|---|
| C→S | `screenshare:subscribe` | — (assina o lobby) |
| S→C | `screenshare:lobby` | lista de salas |
| C→S | `screenshare:join` | `{ roomId, password, watchReason }` |
| S→C | `screenshare:joined` | sala entrou |
| S→C | `screenshare:state` | estado da sala (membros + screen) |
| S→C | `screenshare:join_denied` | entrada negada |
| S→C | `screenshare:replaced` | sessão substituída |
| S→C | `screenshare:closed` | sala encerrada |
| C→S | `screenshare:create` | `{ name, password?, inviteToken?, announceChannelId? }` |
| C→S | `screenshare:leave` | — |

Lobby (por sala): `roomId`, `name`, `memberCount`, `hasPassword`.
Membros (estado): `userId`, `displayName`, `avatar`, `screenId`, `screenAudio`,
`screenTransport` (`"mediamtx" | "cloudflare"`).

### REST (cookie de sessão)

| Uso | Método | Path | Body |
|---|---|---|---|
| ICE | `GET` | `/api/rtc/ice?purpose=screenshare` | — |
| Publicar (WHIP) | `POST` | `/api/compartilhagram/sfu/screen/whip` | `{ roomId, socketId, sdp }` |
| Assistir (WHEP) | `POST` | `/api/compartilhagram/sfu/screen/whep` | `{ roomId, socketId, sdp }` |
| Soltar tela | `POST` | `/api/compartilhagram/sfu/screen` | `{ roomId, socketId, on: false }` |
| Fechar mídia | `POST` | `/api/compartilhagram/sfu/close` | `{ roomId, socketId, ... }` |

Respostas WHIP/WHEP: `{ sdp }`. O `socketId` é o id do **nosso** socket que entrou
na sala. ICE: `{ iceServers: [...] }`.

## Escopo

### Fase 1 (esta spec)

1. **Sessão web**: janela de login no site; cookies persistidos na sessão padrão;
   status "logado como X"; cookie nunca cruza pro renderer.
2. **Socket da sala no main**: autenticado por cookie; lobby, join, leave, create,
   estado da sala (quem está, quem transmite).
3. **UI de salas** no `ButecoPanel`: sai o "Parear"; entra lista de salas do lobby
   (nome, membros, cadeado), entrar com senha quando houver, e criar sala.
4. **Transmitir sem código**: mesmo controller WebRTC; troca SDP via WHIP do site;
   parar via `/sfu/screen {on:false}`; ICE via `/api/rtc/ice`.
5. **Módulo antigo de pairing** fica no código, sem UI (fallback técnico).

### Fase 2 (spec futura)

- Viewer WHEP + emulação do estado de stream do Discord (tile/player nativos com
  nossa mídia). Spike à parte; fallback: tile próprio.

### Fora de escopo

- Câmera; simulcast/layers (`/sfu/layer`); `cloudflare` transport; anunciar sala
  em canal do Discord; pairing code (continua existindo no backend, sem UI).

## Arquitetura

```
Renderer (Discord)
  renderer/buteco/ButecoPanel.tsx     UI de sessão/salas + fonte/qualidade/áudio
  renderer/buteco/webState.ts         store do estado web (puro, testável)
  renderer/buteco/useButecoWeb.ts     hook + assinatura do envelope
  renderer/components/ScreenSharePicker.tsx  startButecoPublish (web)
        │  VesktopNative.buteco.web (IPC)
Main (Node)
  main/buteco/webSession.ts   cookie da sessão + janela de login + status
  main/buteco/webApi.ts       ICE/WHIP/WHEP/screen/close com cookie
  main/buteco/roomSocket.ts   socket.io autenticado por cookie
  main/buteco/webStore.ts     estado web + emissão de eventos
  main/buteco/web.ts          registerButecoWeb() + handlers IPC
        │  HTTPS / Socket.IO
games.butecodosdevs.com
```

Princípios:

- **Main faz rede** (cookies nunca vão ao renderer); **renderer faz WebRTC** — mesmo
  padrão do módulo helper atual.
- Nenhuma mudança no backend do Buteco.
- `ipcWrappers.handle` preservado em todos os handlers novos.
- ESTILO: 4 espaços, double quotes, header GPL-3.0.

## Sessão web (`webSession.ts`)

- Cookie lido de `session.defaultSession.cookies.get({ url: BUTECO_WEB_ORIGIN })`
  e filtrado por nome. O header é montado como `name=value` — **nunca logado**.
- Login: `BrowserWindow` (sessão padrão, para reaproveitar o login do Discord no
  OAuth) apontando para `/login`; poll do cookie a cada 1 s; resolve quando o
  cookie aparece ou a janela fecha. `ButecoWebStatus` = `{ loggedIn, user }`, com
  user via `GET /api/auth/get-session` (best-effort; falha → `user: null`).
- `getWebStatusFrom(cookie, fetchImpl)` é a parte pura/testável.

## Socket da sala (`roomSocket.ts`)

- `createRoomSocket({ cookieHeader, ioImpl?, onEvent })` com injeção do `io` para
  testes. No main real: `extraHeaders: { Cookie }` (o transport websocket do
  engine.io-client 6 no Node envia os headers — verificado no node_modules).
- `getSocketId()` exposto para o WHIP/WHEP.
- Reconexão: se o socket reconectar com outro id durante um publish, a publicação
  cai (o SFU fecha ao sumir o socket); tratamos com erro `network` e o usuário
  reinicia. Sem tentativa de reenvio de SDP nesta fase.
- Eventos mapeados para `ButecoWebEvent` (lobby/room/closed/join-denied).

## API web (`webApi.ts`)

- `webRequest<T>(path, { method, body, cookieHeader?, fetchImpl? })` no mesmo molde
  de `groundRequest`: `AbortSignal.timeout(15_000)`, `accept: application/json`,
  `cookie` header, erros mapeados por `mapGroundRefusal` (401 → `token_invalid`).
- `fetchWebIce()` → `ButecoIceServer[]`.
- `webPublishScreen(roomId, socketId, sdp)` → `{ sdp }`.
- `webReleaseScreen(roomId, socketId)` → `POST /sfu/screen { on: false }`.
- `webCloseConnection(roomId, socketId)` → `/sfu/close` (best-effort no stop).

## Estado e IPC

Novos `IpcEvents`:

```
BUTECO_WEB_STATUS, BUTECO_WEB_LOGIN, BUTECO_WEB_LOBBY,
BUTECO_ROOM_JOIN, BUTECO_ROOM_LEAVE, BUTECO_ROOM_CREATE,
BUTECO_WEB_ICE, BUTECO_WEB_PUBLISH, BUTECO_WEB_UNPUBLISH,
BUTECO_WEB_EVENT
```

`webStore` (padrão do `store.ts` atual):

```ts
interface ButecoWebState {
    status: { loggedIn: boolean; user: ButecoWebUser | null };
    lobby: ButecoRoomSummary[] | null; // null = nunca assinou
    room: ButecoRoomState | null;
}
```

Envelope em `BUTECO_WEB_EVENT`: `{ state, event? }` (mesmo padrão redigido do
helper; aqui não há token — só estado público da sala).

Fluxos:

- Painel abre → `web.status()`; se logado → `web.lobby()` (cria socket + subscribe).
- `login()` → janela; ao logar, status + socket + lobby.
- `join/leave/create` → socket; erros de join viram evento `join-denied`.
- `publish(sdp)` → main lê `room` + `socketId` do store → WHIP.
- `unpublish()` → release + close best-effort.

## UI (`ButecoPanel`)

Estados do painel:

1. **Deslogado**: texto + botão "Entrar no Buteco Games" (abre a janela).
2. **Logado, fora de sala**: lista do lobby (atualiza por evento) com "Entrar"
   (senha quando `hasPassword`); "Criar sala" (nome + senha opcional).
3. **Em sala**: cabeçalho (nome + nº de membros + "Sair"), depois fonte/qualidade/
   áudio/iniciar como hoje. A sala escolhida é lembrada por canal de voz
   (`State.lastButecoRoomByChannel`) para reentrada com 1 clique.

`ButecoPick`/qualidade continuam locais (captura). Sem limites do servidor na via
web: defaults 1440p/60 e áudio habilitado; `session` do painel vira `null`.

## Testes

- Unitários (vitest) com injeção:
  - `butecoWeb.ts`: mappers de lobby/sala/estado.
  - `webSession`: `cookieHeaderFrom`, `parseSessionUser`, `getWebStatusFrom`.
  - `webApi`: URL/método/body/cookie/erros com fetch fake.
  - `roomSocket`: io fake (lobby/join/state/closed/denied; header no connect).
  - `webStore`: estado/assinatura/eventos.
  - `webState` (renderer): envelope → estado.
- Sem testes de rede real; validação manual com a sala do Buteco.

## Riscos

- **Socket cookie handshake**: coberto pelo `extraHeaders` do engine.io-client 6
  (Node). Se falhar em campo, fallback é manter o socket numa janela oculta no
  domínio do site e o main conversar com ela (mesmo contrato de `roomSocket`).
- **Formato do lobby/state** pode variar: mappers tolerantes (campos opcionais,
  listas vazias em vez de throw).
- **Login OAuth**: primeira vez pode exigir "Autorizar" no site; a janela é visível
  e explícita.
- **Reconexão do socket durante publish**: cair para `idle` com erro `network`.
- **Sessão expirada**: 401 → `token_invalid` → UI volta ao estado deslogado.

## Critérios de aceite (Fase 1)

1. Login uma única vez; status mostra o usuário; sem pairing code.
2. Lobby lista salas ao vivo; entrar com/sem senha; criar sala; sair.
3. Transmitir tela: WHIP do site, stream visível na sala (site), parar encerra.
4. Erros mapeados (sala cheia, senha errada, tela já ativa, sessão expirada).
5. `pnpm lint`, `pnpm testTypes`, `pnpm test:unit` e `pnpm build` verdes.
