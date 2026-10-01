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

import { BUTECO_ERROR_MESSAGES, isRepairErrorCode } from "./messages";
import { BUTECO_FPS, BUTECO_HEIGHTS, clampFps, clampHeight } from "./quality";

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

/**
 * Pairing step, shared by the initial unpaired state and the re-pair state
 * reached when a stored session goes stale (`token_invalid` / `client_outdated`).
 * When an error is present its mapped message replaces the intro text, so a
 * stale session reads as an explicit "pair again" prompt.
 */
function PairForm({
    onPair,
    error,
    intro
}: {
    onPair: (code: string) => Promise<boolean>;
    error: ButecoError | null;
    intro: string;
}) {
    const [code, setCode] = useState("");
    const [pairing, setPairing] = useState(false);
    const [pairFailed, setPairFailed] = useState(false);

    async function handlePair() {
        if (pairing) return;
        setPairing(true);
        setPairFailed(false);
        try {
            setPairFailed(!(await onPair(code)));
        } finally {
            setPairing(false);
        }
    }

    return (
        <div>
            <HeadingTertiary>Conectar ao Buteco Games</HeadingTertiary>
            <Paragraph>{intro}</Paragraph>
            {error ? <Paragraph>{BUTECO_ERROR_MESSAGES[error.code]}</Paragraph> : null}
            <input
                value={code}
                onChange={e => setCode(e.currentTarget.value)}
                placeholder="CÓDIGO"
                disabled={pairing}
            />
            <Button type="button" disabled={pairing || !code} onClick={handlePair}>
                {pairing ? "Pareando..." : "Parear"}
            </Button>
            {pairFailed && !error ? <Paragraph>Código inválido ou falha de rede. Tente novamente.</Paragraph> : null}
        </div>
    );
}

export function ButecoPanel({
    pick,
    onPick,
    onStart,
    paired,
    onPair,
    error,
    needsRepair,
    session
}: {
    pick: ButecoPick | null;
    onPick: (p: ButecoPick) => void;
    onStart: () => void;
    paired: boolean;
    onPair: (code: string) => Promise<boolean>;
    /** Latest Buteco failure to surface, mapped to a human-readable message. */
    error: ButecoError | null;
    /**
     * Sticky flag set on a stale session (token_invalid / client_outdated) and
     * cleared only by a successful pair, so a transient non-repair failure while
     * re-pairing keeps the pairing input on screen.
     */
    needsRepair: boolean;
    /** Latest token-redacted session, source of the quality limits. */
    session: ButecoWireSession | null;
}) {
    const [sources] = useAwaiter<ButecoSource[]>(() => VesktopNative.buteco.listSources(), {
        fallbackValue: [],
        deps: []
    });

    // A stale session (token_invalid / client_outdated) can only be fixed by
    // pairing again, so drop straight back to the pairing screen and say so.
    // `needsRepair` keeps it there across a failed re-pair attempt (the latest
    // error may then be a transient `network`/`invalid_code_format`).
    if (paired && (needsRepair || isRepairErrorCode(error?.code))) {
        return (
            <PairForm
                onPair={onPair}
                error={error}
                intro="Sua sessão expirou. Informe um novo código de pareamento exibido na sala do Buteco."
            />
        );
    }

    if (!paired) {
        return (
            <PairForm onPair={onPair} error={error} intro="Informe o código de pareamento exibido na sala do Buteco." />
        );
    }

    return (
        <div>
            {error ? <Paragraph>{BUTECO_ERROR_MESSAGES[error.code]}</Paragraph> : null}
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
