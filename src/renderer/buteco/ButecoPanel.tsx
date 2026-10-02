/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, Heading, HeadingTertiary, Paragraph } from "@vencord/types/components";
import { useAwaiter, useForceUpdater } from "@vencord/types/utils";
import { useState } from "@vencord/types/webpack/common";
import type { Node } from "@vencord/venmic";
import type { ButecoWireSession } from "main/buteco/store";
import type { ButecoPick } from "renderer/components/ScreenSharePicker";
import { useSettings } from "renderer/settings";
import { isLinux } from "renderer/utils";
import type { ButecoError, ButecoSource } from "shared/buteco";
import type { ButecoRoomState } from "shared/butecoWeb";

import { BUTECO_ERROR_MESSAGES } from "./messages";
import { BUTECO_FPS, BUTECO_HEIGHTS, clampFps, clampHeight } from "./quality";
import { useButecoWebState } from "./useButecoWeb";

type VirtmicList = Awaited<ReturnType<typeof VesktopNative.virtmic.list>>;

/** Safe fallback used off Linux (venmic has no IPC handler there). */
const EMPTY_VIRTMIC_LIST: VirtmicList = { ok: true, targets: [], hasPipewirePulse: true };

/**
 * Ordered by preference: the human-facing app name first, falling back to
 * node description/name. Mirrors the native Linux picker so the same targets
 * are offered and matched by the same partial node properties.
 */
const AUDIO_NAME_PROPS = ["application.name", "node.description", "node.name", "application.process.binary"] as const;

interface VenmicAudioItem {
    name: string;
    value: Node;
}

function toAudioItem(node: Node, deviceSelect?: boolean): VenmicAudioItem | null {
    const mediaClass = node["media.class"];

    if (mediaClass?.includes("Video") || mediaClass?.includes("Midi")) {
        return null;
    }

    if (!deviceSelect && node["device.id"]) {
        return null;
    }

    const prop = AUDIO_NAME_PROPS.find(prop => node[prop]);
    if (!prop) {
        return null;
    }

    const name = node[prop];
    return { name, value: { [prop]: name } };
}

function dedupeByName(items: VenmicAudioItem[]): VenmicAudioItem[] {
    return items.filter((item, index, list) => list.findIndex(x => x.name === item.name) === index);
}

function isSameNode(a: Node, b: Node): boolean {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

/** Human-readable publish label derived from the selected nodes. */
function audioLabelFor(nodes: Node[]): string | null {
    const labels = nodes.map(node => Object.values(node)[0]).filter((label): label is string => Boolean(label));
    return labels.length ? labels.join(", ") : null;
}

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

    // A lista de fontes não depende de sala: a sala nasce ao iniciar.
    const [sources] = useAwaiter<ButecoSource[]>(
        () => (web.status.loggedIn ? VesktopNative.buteco.listSources() : Promise.resolve([])),
        { fallbackValue: [], deps: [web.status.loggedIn] }
    );

    if (!web.status.loggedIn) return <ButecoLogin />;

    return (
        <div>
            {web.room ? (
                <ButecoRoomHeader room={web.room} />
            ) : (
                <Paragraph>
                    Conectado como {web.status.user?.displayName ?? "—"}. Ao iniciar, uma sala com nome aleatório e sem
                    senha é criada para você.
                </Paragraph>
            )}
            {error ? (
                <Paragraph>
                    {error.code === "network" && error.message && !error.message.startsWith("HTTP")
                        ? error.message
                        : BUTECO_ERROR_MESSAGES[error.code]}
                </Paragraph>
            ) : null}
            <HeadingTertiary>Fonte</HeadingTertiary>
            <div>
                {sources.map(s => (
                    <button
                        key={s.id}
                        type="button"
                        data-selected={pick?.sourceId === s.id}
                        onClick={() =>
                            onPick({
                                sourceId: s.id,
                                videoKind: s.kind,
                                videoLabel: s.name,
                                height: clampHeight(pick?.height, session?.limits.maxHeight),
                                fps: clampFps(pick?.fps, session?.limits.maxFps),
                                mic: pick?.mic ?? true,
                                // Preserve a previously chosen audio selection when
                                // the user switches source.
                                includeAudioNodes: pick?.includeAudioNodes ?? [],
                                audioLabel: pick?.audioLabel ?? null
                            })
                        }
                    >
                        {s.thumbnailDataUrl ? <img src={s.thumbnailDataUrl} alt="" /> : null}
                        {s.name}
                    </button>
                ))}
            </div>
            {pick ? <ButecoQualityControls pick={pick} onPick={onPick} session={session} /> : null}
            {pick ? <ButecoAudioPicker pick={pick} onPick={onPick} /> : null}
            <Button disabled={!pick} onClick={onStart}>
                Iniciar
            </Button>
        </div>
    );
}

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

/**
 * Resolution / frame-rate / microphone controls for the Buteco path. Every
 * value written to the pick is clamped to `session.limits` (and to the values
 * the strict publish schema accepts) before it can reach `ButecoPublishMeta`.
 */
function ButecoQualityControls({
    pick,
    onPick,
    session
}: {
    pick: ButecoPick;
    onPick: (p: ButecoPick) => void;
    session: ButecoWireSession | null;
}) {
    const limits = session?.limits;
    const height = clampHeight(pick.height, limits?.maxHeight);
    const fps = clampFps(pick.fps, limits?.maxFps);
    const heights = BUTECO_HEIGHTS.filter(h => h <= (limits?.maxHeight ?? BUTECO_HEIGHTS[BUTECO_HEIGHTS.length - 1]));
    const fpsOptions = BUTECO_FPS.filter(f => f <= (limits?.maxFps ?? BUTECO_FPS[BUTECO_FPS.length - 1]));

    return (
        <div>
            <HeadingTertiary>Qualidade</HeadingTertiary>
            <section>
                <Heading tag="h5">Resolução</Heading>
                <div>
                    {(heights.length ? heights : [BUTECO_HEIGHTS[0]]).map(option => (
                        <label key={option} data-checked={height === option}>
                            <input
                                type="radio"
                                name="buteco-height"
                                value={option}
                                checked={height === option}
                                onChange={() => onPick({ ...pick, height: option })}
                            />
                            {option}p
                        </label>
                    ))}
                </div>
            </section>
            <section>
                <Heading tag="h5">Taxa de quadros</Heading>
                <div>
                    {(fpsOptions.length ? fpsOptions : [BUTECO_FPS[0]]).map(option => (
                        <label key={option} data-checked={fps === option}>
                            <input
                                type="radio"
                                name="buteco-fps"
                                value={option}
                                checked={fps === option}
                                onChange={() => onPick({ ...pick, fps: option })}
                            />
                            {option} fps
                        </label>
                    ))}
                </div>
            </section>
            <label>
                <input
                    type="checkbox"
                    checked={pick.mic}
                    onChange={e => onPick({ ...pick, mic: e.currentTarget.checked })}
                />
                Microfone
            </label>
        </div>
    );
}

/**
 * App-audio selection for the Buteco path. Lists the venmic targets exposed by
 * `VesktopNative.virtmic.list()` and stores the chosen partial nodes on the
 * pick; the controller (not this panel) starts/stops the virtmic.
 */
function ButecoAudioPicker({ pick, onPick }: { pick: ButecoPick; onPick: (p: ButecoPick) => void }) {
    const Settings = useSettings();
    const [enabled, setEnabled] = useState(() => (pick.includeAudioNodes?.length ?? 0) > 0);
    const [audioSourcesSignal, refreshAudioSources] = useForceUpdater(true);
    const [venmic] = useAwaiter<VirtmicList>(
        () => (isLinux ? VesktopNative.virtmic.list() : Promise.resolve(EMPTY_VIRTMIC_LIST)),
        { fallbackValue: EMPTY_VIRTMIC_LIST, deps: [audioSourcesSignal] }
    );

    const items = venmic.ok
        ? dedupeByName(
              venmic.targets.map(target => toAudioItem(target, Settings.audio?.deviceSelect)).filter(isAudioItem)
          )
        : [];

    function setEnabledState(next: boolean) {
        setEnabled(next);
        if (!next) {
            onPick({ ...pick, includeAudioNodes: [], audioLabel: null });
        }
    }

    function toggleNode(node: Node) {
        const current = pick.includeAudioNodes ?? [];
        const selected = current.some(existing => isSameNode(existing, node));
        const next = selected ? current.filter(existing => !isSameNode(existing, node)) : [...current, node];
        onPick({ ...pick, includeAudioNodes: next, audioLabel: audioLabelFor(next) });
    }

    return (
        <div>
            <HeadingTertiary>Áudio do sistema</HeadingTertiary>
            <label>
                <input type="checkbox" checked={enabled} onChange={e => setEnabledState(e.currentTarget.checked)} />
                Compartilhar áudio do sistema
            </label>
            {enabled ? (
                <>
                    {!venmic.ok ? (
                        venmic.isGlibCxxOutdated ? (
                            <Paragraph>
                                Não foi possível listar as fontes de áudio porque sua biblioteca C++ é antiga demais
                                para rodar o{" "}
                                <a href="https://github.com/Vencord/venmic" target="_blank" rel="noreferrer">
                                    venmic
                                </a>
                                . Veja{" "}
                                <a
                                    href="https://gist.github.com/Vendicated/b655044ffbb16b2716095a448c6d827a"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    este guia
                                </a>{" "}
                                para possíveis soluções.
                            </Paragraph>
                        ) : (
                            <Paragraph>Não foi possível listar as fontes de áudio.</Paragraph>
                        )
                    ) : !venmic.hasPipewirePulse ? (
                        <Paragraph>
                            Aviso: pipewire-pulse não encontrado; apenas apps sob PipeWire terão o áudio compartilhado.
                        </Paragraph>
                    ) : null}
                    <div>
                        {items.map(item => (
                            <label key={item.name}>
                                <input
                                    type="checkbox"
                                    checked={(pick.includeAudioNodes ?? []).some(node => isSameNode(node, item.value))}
                                    onChange={() => toggleNode(item.value)}
                                />
                                {item.name}
                            </label>
                        ))}
                    </div>
                    <Button variant="secondary" onClick={refreshAudioSources}>
                        Atualizar fontes de áudio
                    </Button>
                </>
            ) : null}
        </div>
    );
}

function isAudioItem(item: VenmicAudioItem | null): item is VenmicAudioItem {
    return item !== null;
}
