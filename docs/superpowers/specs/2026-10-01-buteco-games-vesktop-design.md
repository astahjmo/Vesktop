# Buteco Games no Vesktop — Design

Data: 2026-10-01
Status: aprovado (design), pendente de plano de implementação

## Objetivo

Adicionar ao Vesktop a capacidade de compartilhar a **tela** através do SFU do
**Buteco Games** (`https://games.butecodosdevs.com`), em vez do SFU do Discord.
O usuário escolhe o destino (`Native | Buteco Games`) no próprio Screen Share
Picker do Vesktop. Quando "Buteco Games" está selecionado, **nada** é enviado ao
SFU do Discord; a UI nativa de transmissão do Discord é usada apenas como
interface (estado local emulado), sem mídia real no Discord.

Base de referência: **Buteco Games Companion 0.1.2** (AppImage Electron),
que é um *Desktop Share Helper*. Todo o protocolo abaixo foi extraído do
`app.asar` desse binário (main + preload + renderer).

## Decisões de escopo

- **Plan B — módulo no Vesktop** (`src/main/buteco/` + `src/renderer/buteco/`).
  Não é userplugin do Vencord. Motivo técnico: o *toggle no Screen Share Picker*
  exige mexer num componente do Vesktop (`src/renderer/components/ScreenSharePicker.tsx`),
  e userplugins do Vencord exigem fork/build do Vencord. O módulo usa as APIs do
  Vencord que o Vesktop já expõe (o picker já faz isso hoje), sem tocar no sistema
  de plugins do Vencord.
- **Sem fork do Vencord.**
- **Câmera fica de fora.** O protocolo do Buteco só aceita `videoKind: "screen" | "window"`
  (`publishRequestSchema.meta` é `strict()` e não há `"camera"`); o único
  `getUserMedia` do Companion é áudio (`video: false`). Publicar câmera exigiria
  mudança no backend do Buteco.
- **Paridade com o Companion** para o que é suportado: tela/janela + áudio (mic e
  app-audio) + socket.io (sessão/limites/status) + seleção de fonte e qualidade.
- **Áudio** reaproveita o `venmic` do Vesktop (microfone virtual
  `vencord-screen-share`), não o sidecar `media-helper` do Companion.

## Pré-requisitos e build

- O módulo é compilado pelo build do próprio Vesktop. `scripts/build/build.mts`
  já empacota `src/main/index.ts`, `src/preload/index.ts` e `src/renderer/index.ts`;
  basta importar os novos módulos a partir desses entry points. **Nenhuma mudança
  no build é necessária.**
- Rodar com `pnpm start:dev` / `pnpm watch`.

## Arquitetura

```
Renderer (Discord + Vesktop renderer)
  renderer/buteco/controller.ts     RTCPeerConnection (sendonly), captura, áudio
  renderer/buteco/ButecoPanel.tsx   aba "Buteco Games" no ScreenSharePicker
  renderer/buteco/streamState.ts    emulação do estado de stream p/ UI nativa
        │  VesktopNative.buteco (IPC)
Main (Node)
  main/buteco/index.ts              registra handlers IPC
  main/buteco/ground.ts             fetch + Bearer + timeout + mapeamento de erros
  main/buteco/pairing.ts            exchange + token vault
  main/buteco/socket.ts             socket.io-client em /helper
  main/buteco/whip.ts               publish/unpublish/refreshIce/unpair
  main/buteco/capture.ts            armCapture(sourceId) — captura de uso único
  main/buteco/store.ts              estado em memória + emissão de eventos
  main/screenShare.ts               hook: consumir captura armada / cancelar Go Live
        │  HTTP / Socket.IO / WebRTC
games.butecodosdevs.com  (/api/compartilhagram/...)
```

## Protocolo do Buteco (extraído do Companion 0.1.2)

Base: `https://games.butecodosdevs.com`. Timeout de req: 15 s.

| Uso | Método | Path |
|---|---|---|
| Troca de pairing code | `POST` | `/api/compartilhagram/pairing/exchange` |
| Publicar (WHIP) | `POST` | `/api/compartilhagram/helper/screen/whip` |
| Despublicar | `DELETE` | `/api/compartilhagram/helper/screen` |
| Refresh de ICE | `GET` | `/api/compartilhagram/helper/ice` |
| Despareamento | `DELETE` | `/api/compartilhagram/helper/pairing` |

`exchange` (`{code, client}`) → `{ token, tokenExpiresAt, room{id,slug,name,url?},
user{id,displayName}, socket{url, path:"/socket.io", namespace:"/helper"},
iceServers[], limits{screenAudioAllowed,maxHeight∈{720,1080,1440},maxFps∈{30,60},
maxVideoKbps,audioKbps}, screen{takenBy|null}, serverNow }`.

`client`: `{ app:"buteco-share", version, os, osVersion, protocol:1,
capabilities:{ appAudio:false, mic:true, maxHeight:1440, maxFps:60 } }`.

Socket.IO em `${socket.url}/helper`, `path:"/socket.io"`, `transports:["websocket"]`,
`auth:{ token, protocol:1 }`. Recebe `helper:session`, `helper:revoked`,
`helper:stop_requested`, `helper:screen_lost`; emite `helper:status` (fase +
video/audio/mic/stats), com cap de 1/s e um único status pendente enquanto
desconectado.

`publish` (`{ sdp, meta, takeover? }`, Bearer) → `{ sdp, streamId }`.
`meta = { videoKind:"screen"|"window", videoLabel, audioLabel:string|null,
mic:boolean, height, fps }` (strict). Retry de `busy`: 500/1000/2000 ms →
`sfu_unavailable`.

Erros relevantes: `invalid_code_format`, `token_invalid`, `client_outdated`,
`network`, `unsupported`, `permission_denied`, `video_capture_failed`,
`screen_audio_disabled`, `screen_taken`, `screen_taken_self`, `sfu_unavailable`,
`device_error`.

## Fluxo de entrada e captura (o ponto mais delicado)

O `getDisplayMedia` do renderer é atendido pelo `setDisplayMediaRequestHandler`
do main (`src/main/screenShare.ts`), que hoje sempre abre o picker. O fluxo nativo:

```
Discord Go Live → getDisplayMedia → handler → picker → handler concede fonte → Discord
```

No modo Buteco, **não** queremos conceder a fonte ao Discord. Sequência:

1. Discord chama `getDisplayMedia` → handler abre o picker (chamada fica pendente).
2. Usuário escolhe "Buteco Games", configura (fonte, qualidade, áudio) e clica **Iniciar**.
3. O renderer chama `VesktopNative.buteco.armCapture(sourceId)` (main guarda a
   escolha: `{sourceId, armedAt, token}`, single-use, TTL 10 s).
4. O picker sinaliza "Buteco" (não "native"); o handler responde `callback({})` ao
   Discord → o Go Live é **cancelado** e o Discord trata como cancelamento do usuário.
5. O **módulo** (renderer) chama `navigator.mediaDevices.getDisplayMedia()`. Essa é
   uma segunda chamada, iniciada pelo módulo; o handler vê a captura armada e
   responde `callback({ video: armedSource })` **sem abrir o picker**.
6. O módulo monta o `RTCPeerConnection`, publica e segue.

> Observação: "armar" existe só para evitar reabrir o picker na chamada do módulo
> (passo 5). O módulo **usa** `getDisplayMedia` normalmente; não há captura paralela
> nem bypass do handler.

Consumo é single-use com TTL curto; se expirar ou já tiver sido consumido, o handler
volta ao comportamento padrão (abre o picker) e loga um aviso.

Wayland: o handler já entrega 1 fonte (portal). A captura armada funciona igual,
com o `sourceId` do portal.

## Módulo main (`src/main/buteco/`)

- `ground.ts`: base fixa; `fetch` com `AbortSignal.timeout(15000)`; header
  `authorization: Bearer`; mapeamento de status/erros → códigos acima; guarda de
  origem (só a base do Buteco).
- `pairing.ts`: `normalizePairingCode`, `exchange`, e token vault com expiração
  (`tokenExpiresAt`); `get()` retorna `null` após expirar.
- `socket.ts`: cliente socket.io com reconexão, cap de status 1/s, status pendente,
  `reconnect_failed → offline`, tratamento de `token_invalid`/`client_outdated`.
- `whip.ts`: publish (com retry de busy), unpublish, refreshIce, unpair.
- `capture.ts`: estado `armCapture/cancelCapture/consume`.
- `store.ts`: estado em memória (session, publish, phase) + emissão de eventos ao
  renderer via `webContents.send`.
- `index.ts`: `registerButeco()` chamado no boot do main; registra handlers com
  `handle`/`handleSync` de `utils/ipcWrappers` (validação de sender preservada).

## Módulo renderer (`src/renderer/buteco/`)

- `controller.ts`: obtém a track (via captura armada), monta
  `new RTCPeerConnection({ iceServers, bundlePolicy:"max-bundle" })`,
  `addTransceiver(track, { direction:"sendonly", streams:[stream] })`,
  preferência de codec h264/vp8, `createOffer` → `setLocalDescription` →
  `publish(offerSdp, meta)` → `setRemoteDescription({type:"answer", sdp})`.
  Áudio: mic via `getUserMedia({audio})`; app-audio via `VesktopNative.virtmic` →
  device `vencord-screen-share`; ambos gated por `limits.screenAudioAllowed`.
  Ciclo de vida: encerra tracks e faz `unpublish` em `revoked/stop_requested/
  screen_lost/disconnect`.
- `ButecoPanel.tsx`: aba "Buteco Games" dentro do `ScreenSharePicker` — pairing code
  e status da sala; grade de fontes com thumbnails (fonte: `desktopCapturer` do
  main, novo handler `listScreenSources`); qualidade `720/1080/1440` × `30/60`;
  contentHint (motion/detail); seleção de áudio (reaproveita a UI de audio sources
  do picker atual); botão **Iniciar**.
- `streamState.ts`: emulação do estado de stream do Discord para exibir o
  indicador/painel nativos e o botão **Parar** (chama `buteco.unpublish`), **sem**
  enviar mídia ao SFU do Discord.

## Toggle e persistência

- Toggle `Native | Buteco Games` no topo do `ScreenSharePicker`.
- O modo Buteco é **persistente** (guarda em `Settings`), valendo para o
  compartilhamento de tela até ser desligado.
- Sem câmera (fora de escopo).

## Controle / status

O Discord não mostra stream nativo, pois o Go Live é cancelado. A UI nativa é
emulada localmente (mock do estado de stream), conforme decidido. Esta é a peça
de **maior risco** (código interno do Discord, sensível à versão) e será tratada
como **spike** com tempo limitado; se não for viável, o fallback é um controle
mínimo próprio do Vesktop (tray já existente: status no tooltip + "Parar").

## Testes

- Adicionar **vitest** como devDependency.
- Testes unitários com mocks:
  - `ground`/`pairing`: fetch mockado; mapeamento de erros; token vault e expiração.
  - `whip`: publish/unpublish; retry de `busy`; `sfu_unavailable`.
  - `socket`: io fake; eventos; cap e status pendente; token_invalid/client_outdated.
  - `capture`: arm/consume single-use e TTL.
  - `controller`: `RTCPeerConnection` fake; offer/answer; transceivers sendonly;
    gating de áudio por limites; limpeza no stop.
- Checklist manual de integração: pairing → publish → answer → live → stop.

## Fases de implementação

1. **Esqueleto + rede**: `shared/buteco.ts`, `main/buteco/{ground,pairing,socket,whip,store,index}`,
   IPC `VesktopNative.buteco`, vitest nos módulos puros.
2. **Captura e desvio**: `capture.ts` + hook em `screenShare.ts`; toggle no picker.
3. **WebRTC + publicação**: `controller.ts`; publish/unpublish end-to-end.
4. **Áudio**: mic + app-audio via venmic, gated por limites.
5. **UX do painel**: `ButecoPanel.tsx` (fontes/thumbnails/qualidade/áudio), erros.
6. **UI nativa (spike)**: `streamState.ts`; fallback tray se inviável.

## Fora de escopo

- Câmera (backend do Buteco não suporta).
- Sidecar de áudio (`media-helper`) — usamos venmic.
- Userplugin do Vencord / fork do Vencord.
- Mudanças no backend do Buteco.

## Riscos

- **UI nativa do Discord (mock de estado)**: alto risco de quebrar por versão.
  Mitigação: spike + fallback tray.
- **Captura armada**: corrida entre `armCapture` e a chamada do módulo.
  Mitigação: single-use + TTL + log.
- **Wayland**: 1 fonte só no portal; validar em sessão Wayland real.
- **`token_invalid`/`client_outdated`**: exigem re-pairing; mapear para UX clara.
