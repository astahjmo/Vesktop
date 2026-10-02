/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "renderer/components/screenSharePicker.css";

import { classNameFactory } from "@vencord/types/api/Styles";
import { Button, Card, FormSwitch, Heading, HeadingTertiary, Paragraph, Span } from "@vencord/types/components";
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
import { describePhase } from "./publishProgress";
import { BUTECO_FPS, BUTECO_HEIGHTS, clampFps, clampHeight } from "./quality";
import { useButecoWebState } from "./useButecoWeb";
import { usePublishPhase } from "./usePublishPhase";

/** Mesmas classes do picker original, para o visual ser o mesmo. */
const cl = classNameFactory("vcd-screen-picker-");

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
    const phase = usePublishPhase();
    const starting = phase.step !== "idle";
    const [choosing, setChoosing] = useState(pick === null);

    // A lista de fontes não depende de sala: a sala nasce ao iniciar.
    const [sources, , sourcesPending] = useAwaiter<ButecoSource[]>(
        () => (web.status.loggedIn ? VesktopNative.buteco.listSources() : Promise.resolve([])),
        { fallbackValue: [], deps: [web.status.loggedIn] }
    );

    if (!web.status.loggedIn) return <ButecoLogin />;

    const selectedSource = sources.find(source => source.id === pick?.sourceId);

    function choose(source: ButecoSource) {
        onPick({
            sourceId: source.id,
            videoKind: source.kind,
            videoLabel: source.name,
            height: clampHeight(pick?.height, session?.limits.maxHeight),
            fps: clampFps(pick?.fps, session?.limits.maxFps),
            mic: pick?.mic ?? true,
            contentHint: pick?.contentHint ?? "motion",
            // Preserve a previously chosen audio selection when the user switches source.
            includeAudioNodes: pick?.includeAudioNodes ?? [],
            audioLabel: pick?.audioLabel ?? null
        });
        setChoosing(false);
    }

    return (
        <div className={cl("buteco")} data-busy={starting}>
            <ButecoRoomCard room={web.room} disabled={starting} displayName={web.status.user?.displayName ?? null} />

            {error ? (
                <Card className={cl("card", "error")}>
                    <Paragraph>
                        {error.code === "network" && error.message && !error.message.startsWith("HTTP")
                            ? error.message
                            : BUTECO_ERROR_MESSAGES[error.code]}
                    </Paragraph>
                </Card>
            ) : null}

            {choosing || !pick ? (
                <SourceGrid
                    sources={sources}
                    loading={sourcesPending}
                    selectedId={pick?.sourceId}
                    onChoose={choose}
                    onCancel={pick ? () => setChoosing(false) : undefined}
                />
            ) : (
                <>
                    <HeadingTertiary>O que você vai transmitir</HeadingTertiary>
                    <Card className={cl("card", "preview")}>
                        {selectedSource?.thumbnailDataUrl ? (
                            <img
                                src={selectedSource.thumbnailDataUrl}
                                alt=""
                                className={cl(isLinux ? "preview-img-linux" : "preview-img")}
                            />
                        ) : (
                            <SourceIcon />
                        )}
                        <Paragraph>{pick.videoLabel}</Paragraph>
                        <Button variant="secondary" size="small" disabled={starting} onClick={() => setChoosing(true)}>
                            Trocar fonte
                        </Button>
                    </Card>

                    <HeadingTertiary>Configurações da transmissão</HeadingTertiary>
                    <Card className={cl("card")}>
                        <ButecoQualityControls pick={pick} onPick={onPick} session={session} />
                        <ButecoAudioPicker pick={pick} onPick={onPick} />
                    </Card>
                </>
            )}

            <div className={cl("start-row")}>
                {starting ? (
                    <div className={cl("progress")} role="status" aria-live="polite">
                        <span className={cl("spinner")} aria-hidden="true" />
                        <Paragraph>{describePhase(phase)}</Paragraph>
                    </div>
                ) : (
                    <span />
                )}
                <Button disabled={!pick || choosing || starting} onClick={onStart}>
                    {starting ? "Conectando…" : "Iniciar"}
                </Button>
            </div>
        </div>
    );
}

function SourceIcon() {
    return (
        <svg className={cl("source-icon")} aria-hidden="true" width="64" height="64" viewBox="0 0 24 24">
            <path
                fill="currentColor"
                d="M2 4.5C2 3.397 2.897 2.5 4 2.5H20C21.103 2.5 22 3.397 22 4.5V15.5C22 16.604 21.103 17.5 20 17.5H13V19.5H17V21.5H7V19.5H11V17.5H4C2.897 17.5 2 16.604 2 15.5V4.5ZM4 4.5V15.5H20V4.5H4Z"
            />
        </svg>
    );
}

/** Grade de telas e janelas, no mesmo formato do picker original. */
function SourceGrid({
    sources,
    loading,
    selectedId,
    onChoose,
    onCancel
}: {
    sources: ButecoSource[];
    loading: boolean;
    selectedId?: string;
    onChoose: (source: ButecoSource) => void;
    onCancel?: () => void;
}) {
    return (
        <div>
            <HeadingTertiary>Escolha o que compartilhar</HeadingTertiary>
            {loading && sources.length === 0 ? (
                <div className={cl("progress")} role="status">
                    <span className={cl("spinner")} aria-hidden="true" />
                    <Paragraph>Procurando telas e janelas…</Paragraph>
                </div>
            ) : sources.length === 0 ? (
                <Paragraph>Nenhuma tela ou janela encontrada.</Paragraph>
            ) : (
                <div className={cl("screen-grid")}>
                    {sources.map(source => (
                        <label key={source.id} className={cl("screen-label")} data-selected={source.id === selectedId}>
                            <input
                                type="radio"
                                className={cl("screen-radio")}
                                name="buteco-source"
                                value={source.id}
                                checked={source.id === selectedId}
                                onChange={() => onChoose(source)}
                            />
                            {source.thumbnailDataUrl ? <img src={source.thumbnailDataUrl} alt="" /> : <SourceIcon />}
                            <Paragraph className={cl("screen-name")}>{source.name}</Paragraph>
                        </label>
                    ))}
                </div>
            )}
            {onCancel ? (
                <Button variant="secondary" size="small" onClick={onCancel}>
                    Voltar
                </Button>
            ) : null}
        </div>
    );
}

/** Mesmos botões segmentados do picker original. */
function OptionRadio<T extends string | number>({
    name,
    options,
    labels,
    value,
    onChange
}: {
    name: string;
    options: readonly T[];
    labels?: string[];
    value: T;
    onChange: (option: T) => void;
}) {
    return (
        <div className={cl("option-radios")}>
            {options.map((option, index) => (
                <label className={cl("option-radio")} data-checked={value === option} key={option}>
                    <Span weight="bold">{labels?.[index] ?? String(option)}</Span>
                    <input
                        className={cl("option-input")}
                        type="radio"
                        name={name}
                        value={option}
                        checked={value === option}
                        onChange={() => onChange(option)}
                    />
                </label>
            ))}
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

function ButecoRoomCard({
    room,
    disabled,
    displayName
}: {
    room: ButecoRoomState | null;
    disabled: boolean;
    displayName: string | null;
}) {
    return (
        <Card className={cl("card", "room")}>
            <div>
                <Paragraph>
                    <Span weight="bold">{room ? room.name : "Sala automática"}</Span>
                </Paragraph>
                <Paragraph>
                    {room
                        ? `${room.members.length} na sala`
                        : `Conectado como ${displayName ?? "—"}. Ao iniciar, uma sala com nome aleatório e sem senha é criada para você.`}
                </Paragraph>
            </div>
            {room ? (
                <Button
                    variant="secondary"
                    size="small"
                    disabled={disabled}
                    onClick={() => void VesktopNative.buteco.web.leaveRoom()}
                >
                    Sair da sala
                </Button>
            ) : null}
        </Card>
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
    const contentHint = pick.contentHint === "detail" ? "detail" : "motion";

    return (
        <>
            <div className={cl("quality")}>
                <section className={cl("quality-section")}>
                    <Heading tag="h5">Resolução</Heading>
                    <OptionRadio
                        name="buteco-height"
                        options={heights.length ? heights : [BUTECO_HEIGHTS[0]]}
                        labels={(heights.length ? heights : [BUTECO_HEIGHTS[0]]).map(option => `${option}p`)}
                        value={height}
                        onChange={option => onPick({ ...pick, height: option })}
                    />
                </section>
                <section className={cl("quality-section")}>
                    <Heading tag="h5">Taxa de quadros</Heading>
                    <OptionRadio
                        name="buteco-fps"
                        options={fpsOptions.length ? fpsOptions : [BUTECO_FPS[0]]}
                        labels={(fpsOptions.length ? fpsOptions : [BUTECO_FPS[0]]).map(option => `${option} fps`)}
                        value={fps}
                        onChange={option => onPick({ ...pick, fps: option })}
                    />
                </section>
            </div>
            <div className={cl("quality")}>
                <section className={cl("quality-section")}>
                    <Heading tag="h5">Tipo de conteúdo</Heading>
                    <OptionRadio
                        name="buteco-content"
                        options={["motion", "detail"] as const}
                        labels={["Priorizar fluidez", "Priorizar nitidez"]}
                        value={contentHint}
                        onChange={option => onPick({ ...pick, contentHint: option })}
                    />
                    <Paragraph className={cl("hint")}>
                        &quot;Priorizar nitidez&quot; reduz bastante a taxa de quadros em troca de uma imagem muito mais
                        limpa (bom para texto e código).
                    </Paragraph>
                </section>
            </div>
            <FormSwitch
                title="Microfone"
                hideBorder
                value={pick.mic}
                onChange={checked => onPick({ ...pick, mic: checked })}
                className={cl("audio")}
            />
        </>
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
            <FormSwitch
                title="Compartilhar áudio do sistema"
                hideBorder
                value={enabled}
                onChange={setEnabledState}
                className={cl("audio")}
            />
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
                    <div className={cl("audio-list")}>
                        {items.map(item => (
                            <label key={item.name} className={cl("audio-item")}>
                                <input
                                    type="checkbox"
                                    checked={(pick.includeAudioNodes ?? []).some(node => isSameNode(node, item.value))}
                                    onChange={() => toggleNode(item.value)}
                                />
                                <Span>{item.name}</Span>
                            </label>
                        ))}
                    </div>
                    <div className={cl("settings-buttons")}>
                        <Button variant="secondary" size="small" onClick={refreshAudioSources}>
                            Atualizar fontes de áudio
                        </Button>
                    </div>
                </>
            ) : null}
        </div>
    );
}

function isAudioItem(item: VenmicAudioItem | null): item is VenmicAudioItem {
    return item !== null;
}
