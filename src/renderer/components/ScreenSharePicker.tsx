/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./screenSharePicker.css";

import { classNameFactory } from "@vencord/types/api/Styles";
import {
    Button,
    Card,
    CogWheel,
    FormSwitch,
    Heading,
    HeadingTertiary,
    Margins,
    Paragraph,
    RestartIcon,
    Span
} from "@vencord/types/components";
import { Logger, useAwaiter, useForceUpdater } from "@vencord/types/utils";
import { onceReady } from "@vencord/types/webpack";
import {
    closeModal,
    FluxDispatcher,
    MediaEngineStore,
    Modal,
    openModal,
    Select,
    UserStore,
    useState
} from "@vencord/types/webpack/common";
import { Node } from "@vencord/venmic";
import type { ButecoEventEnvelope, ButecoWireSession } from "main/buteco/store";
import type { Dispatch, SetStateAction } from "react";
import { ButecoPanel } from "renderer/buteco/ButecoPanel";
import { type ButecoController, createButecoController, type StartOptions } from "renderer/buteco/controller";
import { addPatch } from "renderer/patches/shared";
import { State, useSettings, useVesktopState } from "renderer/settings";
import { isLinux, isWindows } from "renderer/utils";
import type { ButecoError, ButecoResult, ButecoSession } from "shared/buteco";

import { SimpleErrorBoundary } from "./SimpleErrorBoundary";

const StreamResolutions = ["480", "720", "1080", "1440", "2160"] as const;
const StreamFps = ["15", "30", "60"] as const;

const cl = classNameFactory("vcd-screen-picker-");

export type StreamResolution = (typeof StreamResolutions)[number];
export type StreamFps = (typeof StreamFps)[number];

type SpecialSource = "None" | "Entire System";

type AudioSource = SpecialSource | Node;
type AudioSources = SpecialSource | Node[];

interface AudioItem {
    name: string;
    value: AudioSource;
}

interface StreamSettings {
    audio: boolean;
    contentHint?: string;
    includeSources?: AudioSources;
    excludeSources?: AudioSources;
}

export interface StreamPick extends StreamSettings {
    id: string;
    mode?: "native" | "buteco";
}

export interface ButecoPick {
    sourceId: string;
    videoKind: "screen" | "window";
    videoLabel: string;
    height: 720 | 1080 | 1440;
    fps: 30 | 60;
    mic: boolean;
    includeSources?: AudioSources;
    /** Partial venmic node selectors for app/system audio (Buteco path only). */
    includeAudioNodes?: Node[];
    /** Human-readable label for the app-audio track published to the SFU. */
    audioLabel?: string | null;
}

interface Source {
    id: string;
    name: string;
    url: string;
}

export let currentSettings: StreamSettings | null = null;

const logger = new Logger("VesktopScreenShare");

addPatch({
    patches: [
        {
            find: "this.getDefaultGoliveQuality()",
            replacement: {
                match: /this\.getDefaultGoliveQuality\(\)/,
                replace: "$self.patchStreamQuality($&)"
            }
        }
    ],
    patchStreamQuality(opts: any) {
        const { screenshareQuality } = State.store;
        if (!screenshareQuality) return opts;

        const framerate = Number(screenshareQuality.frameRate);
        const height = Number(screenshareQuality.resolution);
        const width = Math.round(height * (16 / 9));

        Object.assign(opts, {
            bitrateMin: 500000,
            bitrateMax: 8000000,
            bitrateTarget: 600000
        });
        if (opts?.encode) {
            Object.assign(opts.encode, {
                framerate,
                width,
                height,
                pixelCount: height * width
            });
        }
        Object.assign(opts.capture, {
            framerate,
            width,
            height,
            pixelCount: height * width
        });
        return opts;
    }
});

const VIRT_MIC_LABEL = "vencord-screen-share";

/**
 * The controller currently publishing to the Buteco Ground, if any. Kept at
 * module scope so a later task (native-UI stop) can end the stream.
 */
export let activeButecoController: ButecoController | null = null;

/** Latest token-redacted session seen on the wire, used to seed `getSession()`. */
let latestButecoSession: ButecoWireSession | null = null;

export function getLatestButecoSession(): ButecoWireSession | null {
    return latestButecoSession;
}

/**
 * Last Buteco error seen after the picker closed, so reopening it surfaces the
 * failure instead of silently looking paired. The wire protocol carries no error
 * events, so publish/start failures are the only source that outlives the modal.
 */
let latestButecoError: ButecoError | null = null;

export function getLatestButecoError(): ButecoError | null {
    return latestButecoError;
}

export function setLatestButecoError(error: ButecoError | null): void {
    latestButecoError = error;
}

/** Idempotently stops the active Buteco stream, if one is publishing. */
export async function stopActiveButeco(): Promise<void> {
    const controller = activeButecoController;
    activeButecoController = null;
    if (controller) await controller.stop().catch(() => {});
}

async function findVirtmicDeviceId(): Promise<string | null> {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.find(d => d.label === VIRT_MIC_LABEL)?.deviceId ?? null;
    } catch {
        return null;
    }
}

/**
 * Arms the capture in main, then builds and starts a Buteco controller with the
 * real media/PC/virtmic/publish dependencies. Must run after the picker's
 * `submit` has resolved, so the main display-media handler is no longer pending
 * (see the armed-capture flow in `src/main/screenShare.ts`).
 */
export async function startButecoPublish(pick: ButecoPick): Promise<ButecoResult<void>> {
    try {
        await stopActiveButeco();
        await VesktopNative.buteco.armCapture(pick.sourceId);

        const controller = createButecoController({
            // The main process stores the full session; the renderer only ever
            // sees the token-redacted wire copy, and the controller reads only
            // iceServers and limits from it.
            getSession: () => (latestButecoSession as ButecoSession | null) ?? null,
            getDisplayMedia: opts => navigator.mediaDevices.getDisplayMedia(opts),
            getUserMedia: opts => navigator.mediaDevices.getUserMedia(opts),
            createPeerConnection: iceServers => new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" }),
            publish: (sdp, meta) => VesktopNative.buteco.publish(sdp, meta),
            unpublish: () => VesktopNative.buteco.unpublish(),
            getVirtmicDeviceId: findVirtmicDeviceId,
            virtmic: {
                start: nodes => VesktopNative.virtmic.start(nodes as Node[]),
                stop: () => VesktopNative.virtmic.stop()
            }
        });

        activeButecoController = controller;

        const res = await controller.start({
            sourceId: pick.sourceId,
            videoKind: pick.videoKind,
            videoLabel: pick.videoLabel,
            height: pick.height,
            fps: pick.fps,
            mic: pick.mic,
            includeAudioNodes: pick.includeAudioNodes ?? [],
            audioLabel: pick.audioLabel ?? null
        } satisfies StartOptions);

        if (!res.ok) {
            await stopActiveButeco();
            // A start can abort before the module's getDisplayMedia consumes the
            // arm (e.g. no session); release it so it cannot leak into a later,
            // unrelated capture. Consumed arms are a harmless no-op.
            await VesktopNative.buteco.cancelCapture();
            setLatestButecoError(res.error);
            return res;
        }

        setLatestButecoError(null);
        return { ok: true, value: undefined };
    } catch {
        await stopActiveButeco();
        await VesktopNative.buteco.cancelCapture();
        const error: ButecoError = { code: "network", message: "Falha ao iniciar a captura." };
        setLatestButecoError(error);
        return { ok: false, error };
    }
}

if (isLinux) {
    onceReady.then(() => {
        const ownsStream = (streamKey: string) => {
            return streamKey.split(":").at(-1) === UserStore.getCurrentUser().id;
        };

        FluxDispatcher.subscribe("STREAM_CLOSE", ({ streamKey }: { streamKey: string }) => {
            if (!ownsStream(streamKey)) {
                return;
            }

            VesktopNative.virtmic.stop();
        });

        FluxDispatcher.subscribe("STREAM_UPDATE", ({ streamKey }: { streamKey: string }) => {
            if (!ownsStream(streamKey)) {
                return;
            }

            VesktopNative.virtmic.unmute();
        });
    });
}

// One long-lived subscription: mirror the token-redacted session carried on
// every Buteco envelope (so the controller's `getSession()` has the ice servers
// / limits at start) and tear the active controller down on terminal events.
onceReady.then(() => {
    VesktopNative.buteco.onEvent(envelope => {
        const { state, event } = envelope as ButecoEventEnvelope;
        latestButecoSession = state.session;

        const type = event?.type;
        if (type === "revoked" || type === "stop_requested" || type === "screen_lost") {
            void stopActiveButeco();
        }
    });
});

export function openScreenSharePicker(screens: Source[], skipPicker: boolean) {
    let didSubmit = false;
    return new Promise<StreamPick>((resolve, reject) => {
        const key = openModal(
            props => (
                <ModalComponent
                    screens={screens}
                    modalProps={props}
                    submit={async v => {
                        didSubmit = true;

                        if (v.mode === "buteco") {
                            // Resolve first: main's pending display-media handler then
                            // sees `mode: "buteco"` and cancels Go Live before the
                            // module's own (armed) capture starts below. Starting the
                            // capture only after that first handler has returned avoids
                            // any chance of the two display-media requests overlapping.
                            // The panel spreads a full ButecoPick into this StreamPick.
                            resolve(v);
                            await startButecoPublish(v as unknown as ButecoPick);
                            return;
                        }

                        if (v.includeSources && v.includeSources !== "None") {
                            if (v.includeSources === "Entire System") {
                                await VesktopNative.virtmic.startSystem(
                                    !v.excludeSources || isSpecialSource(v.excludeSources) ? [] : v.excludeSources
                                );
                            } else {
                                await VesktopNative.virtmic.start(v.includeSources);
                            }
                        }

                        resolve(v);
                    }}
                    close={() => {
                        props.onClose();
                        if (!didSubmit) reject("Aborted");
                    }}
                    skipPicker={skipPicker}
                />
            ),
            {
                onCloseRequest() {
                    closeModal(key);
                    reject("Aborted");
                },
                onCloseCallback() {
                    if (!didSubmit) reject("Aborted");
                }
            }
        );
    });
}

function ScreenPicker({ screens, chooseScreen }: { screens: Source[]; chooseScreen: (id: string) => void }) {
    return (
        <div className={cl("screen-grid")}>
            {screens.map(({ id, name, url }) => (
                <label key={id} className={cl("screen-label")}>
                    <input
                        type="radio"
                        className={cl("screen-radio")}
                        name="screen"
                        value={id}
                        onChange={() => chooseScreen(id)}
                    />

                    <img src={url} alt="" />
                    <Paragraph className={cl("screen-name")}>{name}</Paragraph>
                </label>
            ))}
        </div>
    );
}

function AudioSettingsModal({
    modalProps,
    close,
    setAudioSources
}: {
    modalProps: any;
    close: () => void;
    setAudioSources: (s: AudioSources) => void;
}) {
    const Settings = useSettings();

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Audio Settings"
            actions={[{ text: "Back", variant: "secondary", onClick: close }]}
        >
            <div className={cl("venmic-settings")}>
                <FormSwitch
                    title="Initial Mute"
                    description="Fix an initial audio spike caused by chromium."
                    hideBorder
                    onChange={v => (Settings.audio = { ...Settings.audio, mute: v })}
                    value={Settings.audio?.mute ?? true}
                />
                <FormSwitch
                    title="Microphone Workaround"
                    description="Work around an issue that causes the microphone to be shared instead of the correct audio. Only enable if you're experiencing this issue."
                    hideBorder
                    onChange={v => (Settings.audio = { ...Settings.audio, workaround: v })}
                    value={Settings.audio?.workaround ?? false}
                />
                <FormSwitch
                    title="Only Speakers"
                    description={
                        'When sharing entire desktop audio, only share apps that play to a speaker. You may want to disable this when using "mix bussing".'
                    }
                    hideBorder
                    onChange={v => (Settings.audio = { ...Settings.audio, onlySpeakers: v })}
                    value={Settings.audio?.onlySpeakers ?? true}
                />
                <FormSwitch
                    title="Only Default Speakers"
                    description={
                        <>
                            When sharing entire desktop audio, only share apps that play to the <b>default</b> speakers.
                            You may want to disable this when using "mix bussing".
                        </>
                    }
                    hideBorder
                    onChange={v => (Settings.audio = { ...Settings.audio, onlyDefaultSpeakers: v })}
                    value={Settings.audio?.onlyDefaultSpeakers ?? true}
                />
                <FormSwitch
                    title="Ignore Inputs"
                    description="Exclude nodes that are intended to capture audio."
                    hideBorder
                    onChange={v => (Settings.audio = { ...Settings.audio, ignoreInputMedia: v })}
                    value={Settings.audio?.ignoreInputMedia ?? true}
                />
                <FormSwitch
                    title="Ignore Virtual"
                    description={
                        'Exclude virtual nodes, such as nodes belonging to loopbacks. This might be useful when using "mix bussing".'
                    }
                    hideBorder
                    onChange={v => (Settings.audio = { ...Settings.audio, ignoreVirtual: v })}
                    value={Settings.audio?.ignoreVirtual ?? false}
                />
                <FormSwitch
                    title="Ignore Devices"
                    description="Exclude device nodes, such as nodes belonging to microphones or speakers."
                    hideBorder
                    onChange={v =>
                        (Settings.audio = {
                            ...Settings.audio,
                            ignoreDevices: v,
                            deviceSelect: v ? false : Settings.audio?.deviceSelect
                        })
                    }
                    value={Settings.audio?.ignoreDevices ?? true}
                />
                <FormSwitch
                    title="Granular Selection"
                    description="Allow to select applications more granularly."
                    hideBorder
                    onChange={value => {
                        Settings.audio = { ...Settings.audio, granularSelect: value };
                        setAudioSources("None");
                    }}
                    value={Settings.audio?.granularSelect ?? false}
                />
                <FormSwitch
                    title="Device Selection"
                    description={
                        <>
                            Allow to select devices such as microphones. Requires <b>Ignore Devices</b> to be turned
                            off.
                        </>
                    }
                    hideBorder
                    onChange={value => {
                        Settings.audio = { ...Settings.audio, deviceSelect: value };
                        setAudioSources("None");
                    }}
                    value={Settings.audio?.deviceSelect ?? false}
                    disabled={Settings.audio?.ignoreDevices}
                />
            </div>
        </Modal>
    );
}

function OptionRadio<Settings extends object, Key extends keyof Settings>(props: {
    options: Array<string> | ReadonlyArray<string>;
    labels?: Array<string>;
    settings: Settings;
    settingsKey: Key;
    onChange: (option: string) => void;
}) {
    const { options, settings, settingsKey, labels, onChange } = props;

    return (
        <div className={cl("option-radios")}>
            {(options as string[]).map((option, idx) => (
                <label className={cl("option-radio")} data-checked={settings[settingsKey] === option} key={option}>
                    <Span weight="bold">{labels?.[idx] ?? option}</Span>
                    <input
                        className={cl("option-input")}
                        type="radio"
                        name="fps"
                        value={option}
                        checked={settings[settingsKey] === option}
                        onChange={() => onChange(option)}
                    />
                </label>
            ))}
        </div>
    );
}

function StreamSettingsUi({
    source,
    settings,
    setSettings,
    skipPicker
}: {
    source: Source;
    settings: StreamSettings;
    setSettings: Dispatch<SetStateAction<StreamSettings>>;
    skipPicker: boolean;
}) {
    const Settings = useSettings();
    const qualitySettings = State.store.screenshareQuality!;

    const [thumb] = useAwaiter(
        () => (skipPicker ? Promise.resolve(source.url) : VesktopNative.capturer.getLargeThumbnail(source.id)),
        {
            fallbackValue: source.url,
            deps: [source.id]
        }
    );

    const openSettings = () => {
        openModal(props => (
            <AudioSettingsModal
                modalProps={props}
                close={() => props.onClose()}
                setAudioSources={sources =>
                    setSettings(s => ({ ...s, includeSources: sources, excludeSources: sources }))
                }
            />
        ));
    };

    return (
        <div>
            <HeadingTertiary className={Margins.bottom8}>What you're streaming</HeadingTertiary>
            <Card className={cl("card", "preview")}>
                <img src={thumb} alt="" className={cl(isLinux ? "preview-img-linux" : "preview-img")} />
                <Paragraph>{source.name}</Paragraph>
            </Card>

            <HeadingTertiary className={Margins.bottom8}>Stream Settings</HeadingTertiary>

            <Card className={cl("card")}>
                <div className={cl("quality")}>
                    <section className={cl("quality-section")}>
                        <Heading tag="h5">Resolution</Heading>
                        <OptionRadio
                            options={StreamResolutions}
                            settings={qualitySettings}
                            settingsKey="resolution"
                            onChange={value => (qualitySettings.resolution = value)}
                        />
                    </section>

                    <section className={cl("quality-section")}>
                        <Heading tag="h5">Frame Rate</Heading>
                        <OptionRadio
                            options={StreamFps}
                            settings={qualitySettings}
                            settingsKey="frameRate"
                            onChange={value => (qualitySettings.frameRate = value)}
                        />
                    </section>
                </div>
                <div className={cl("quality")}>
                    <section className={cl("quality-section")}>
                        <Heading tag="h5">Content Type</Heading>
                        <div>
                            <OptionRadio
                                options={["motion", "detail"]}
                                labels={["Prefer Smoothness", "Prefer Clarity"]}
                                settings={settings}
                                settingsKey="contentHint"
                                onChange={option => setSettings(s => ({ ...s, contentHint: option }))}
                            />

                            <Paragraph className={Margins.top8}>
                                Choosing "Prefer Clarity" will result in a significantly lower framerate in exchange for
                                a much sharper and clearer image.
                            </Paragraph>
                        </div>
                        {isWindows && (
                            <FormSwitch
                                title="Stream With Audio"
                                hideBorder
                                value={settings.audio}
                                onChange={checked => setSettings(s => ({ ...s, audio: checked }))}
                                className={cl("audio")}
                            />
                        )}
                    </section>
                </div>

                {isLinux && (
                    <AudioSourcePickerLinux
                        openSettings={openSettings}
                        includeSources={settings.includeSources}
                        excludeSources={settings.excludeSources}
                        deviceSelect={Settings.audio?.deviceSelect}
                        granularSelect={Settings.audio?.granularSelect}
                        setIncludeSources={sources => setSettings(s => ({ ...s, includeSources: sources }))}
                        setExcludeSources={sources => setSettings(s => ({ ...s, excludeSources: sources }))}
                    />
                )}
            </Card>
        </div>
    );
}

function isSpecialSource(value?: AudioSource | AudioSources): value is SpecialSource {
    return typeof value === "string";
}

function mapToAudioItem(node: AudioSource, granularSelect?: boolean, deviceSelect?: boolean): AudioItem[] {
    if (isSpecialSource(node)) {
        return [{ name: node, value: node }];
    }

    const mediaClass = node["media.class"];

    if (mediaClass?.includes("Video") || mediaClass?.includes("Midi")) {
        return [];
    }

    if (!deviceSelect && node["device.id"]) {
        return [];
    }

    const preferred = ["application.name", "node.description", "node.name", "application.process.binary"] as const;
    const prop = preferred.find(prop => node[prop]);

    if (!prop) {
        return [];
    }

    const name = node[prop]!;
    const items: AudioItem[] = [{ name: name, value: { [prop]: name } }];

    if (!granularSelect) {
        return items;
    }

    let granularName = name;
    const granularProps: Node = { [prop]: name };

    const append = (name: string, brackets: string) => {
        const value = node[name];

        if (!value) {
            return;
        }

        granularName += ` ${brackets[0]}${value}${brackets[1]}`;
        granularProps[name] = value;
    };

    append("application.process.id", "<>");
    append("application.process.binary", "()");
    append("media.name", "[]");

    items.push({ name: granularName, value: granularProps });

    return items;
}

function hasMatchingProps(value: Node, other: Node) {
    const keys = Object.keys(value);
    return keys.length === Object.keys(other).length && keys.every(key => value[key] === other[key]);
}

function isItemSelected(sources?: AudioSources) {
    return (value: AudioSource) => {
        if (!sources) {
            return false;
        }

        if (isSpecialSource(sources) || isSpecialSource(value)) {
            return sources === value;
        }

        return sources.some(source => hasMatchingProps(source, value));
    };
}

function updateItems(setSources: (s: AudioSources) => void, sources?: AudioSources) {
    return (value: AudioSource) => {
        if (isSpecialSource(value)) {
            setSources(value);
            return;
        }

        if (isSpecialSource(sources)) {
            setSources([value]);
            return;
        }

        if (isItemSelected(sources)(value)) {
            setSources(sources?.filter(x => !hasMatchingProps(x, value)) ?? "None");
            return;
        }

        setSources([...(sources || []), value]);
    };
}

function AudioSourcePickerLinux({
    includeSources,
    excludeSources,
    deviceSelect,
    granularSelect,
    openSettings,
    setIncludeSources,
    setExcludeSources
}: {
    includeSources?: AudioSources;
    excludeSources?: AudioSources;
    deviceSelect?: boolean;
    granularSelect?: boolean;
    openSettings: () => void;
    setIncludeSources: (s: AudioSources) => void;
    setExcludeSources: (s: AudioSources) => void;
}) {
    const [audioSourcesSignal, refreshAudioSources] = useForceUpdater(true);
    const [sources, _, loading] = useAwaiter(() => VesktopNative.virtmic.list(), {
        fallbackValue: { ok: true, targets: [], hasPipewirePulse: true },
        deps: [audioSourcesSignal]
    });

    const hasPipewirePulse = sources.ok ? sources.hasPipewirePulse : true;
    const [ignorePulseWarning, setIgnorePulseWarning] = useState(false);

    if (!sources.ok && sources.isGlibCxxOutdated) {
        return (
            <Paragraph>
                Failed to retrieve Audio Sources because your C++ library is too old to run
                <a href="https://github.com/Vencord/venmic" target="_blank" rel="noreferrer">
                    venmic
                </a>
                . See{" "}
                <a
                    href="https://gist.github.com/Vendicated/b655044ffbb16b2716095a448c6d827a"
                    target="_blank"
                    rel="noreferrer"
                >
                    this guide
                </a>{" "}
                for possible solutions.
            </Paragraph>
        );
    }

    if (!hasPipewirePulse && !ignorePulseWarning) {
        return (
            <Paragraph>
                Could not find pipewire-pulse. See{" "}
                <a
                    href="https://gist.github.com/the-spyke/2de98b22ff4f978ebf0650c90e82027e#install"
                    target="_blank"
                    rel="noreferrer"
                >
                    this guide
                </a>{" "}
                on how to switch to pipewire. <br />
                You can still continue, however, please{" "}
                <b>beware that you can only share audio of apps that are running under pipewire</b>.{" "}
                <a onClick={() => setIgnorePulseWarning(true)}>I know what I'm doing!</a>
            </Paragraph>
        );
    }

    const specialSources: SpecialSource[] = ["None", "Entire System"] as const;

    const uniqueName = (value: AudioItem, index: number, list: AudioItem[]) =>
        list.findIndex(x => x.name === value.name) === index;

    const allSources = sources.ok
        ? [...specialSources, ...sources.targets]
              .map(target => mapToAudioItem(target, granularSelect, deviceSelect))
              .flat()
              .filter(uniqueName)
        : [];

    return (
        <>
            <div className={cl("audio-sources")}>
                <section>
                    <Heading tag="h5">{loading ? "Loading Sources..." : "Audio Sources"}</Heading>
                    <SimpleErrorBoundary>
                        <Select
                            options={allSources.map(({ name, value }) => ({
                                label: name,
                                value: value,
                                default: name === "None"
                            }))}
                            isSelected={isItemSelected(includeSources)}
                            select={updateItems(setIncludeSources, includeSources)}
                            serialize={JSON.stringify}
                            popoutPosition="top"
                            closeOnSelect={false}
                            renderOptionLabel={o => o.label}
                        />
                    </SimpleErrorBoundary>
                </section>
                {includeSources === "Entire System" && (
                    <section>
                        <Heading tag="h5">Exclude Sources</Heading>
                        <SimpleErrorBoundary>
                            <Select
                                options={allSources
                                    .filter(x => x.name !== "Entire System")
                                    .map(({ name, value }) => ({
                                        label: name,
                                        value: value,
                                        default: name === "None"
                                    }))}
                                isSelected={isItemSelected(excludeSources)}
                                select={updateItems(setExcludeSources, excludeSources)}
                                serialize={JSON.stringify}
                                popoutPosition="top"
                                closeOnSelect={false}
                                renderOptionLabel={o => o.label}
                            />
                        </SimpleErrorBoundary>
                    </section>
                )}
            </div>
            <div className={cl("settings-buttons")}>
                <Button variant="secondary" onClick={refreshAudioSources} className={cl("settings-button")}>
                    <RestartIcon className={cl("settings-button-icon")} />
                    Refresh Audio Sources
                </Button>
                <Button variant="secondary" onClick={openSettings} className={cl("settings-button")}>
                    <CogWheel className={cl("settings-button-icon")} />
                    Open Audio Settings
                </Button>
            </div>
        </>
    );
}

function ModalComponent({
    screens,
    modalProps,
    submit,
    close,
    skipPicker
}: {
    screens: Source[];
    modalProps: any;
    submit: (data: StreamPick) => void;
    close: () => void;
    skipPicker: boolean;
}) {
    const Settings = useSettings();
    const mode = Settings.butecoMode ?? "native";

    const [selected, setSelected] = useState<string | undefined>(skipPicker ? screens[0].id : void 0);
    const [settings, setSettings] = useState<StreamSettings>({
        contentHint: "motion",
        audio: true,
        includeSources: "None"
    });
    const [butecoPick, setButecoPick] = useState<ButecoPick | null>(null);
    const [paired, setPaired] = useState(() => getLatestButecoSession() !== null);
    const [butecoError, setButecoError] = useState<ButecoError | null>(() => getLatestButecoError());
    const qualitySettings = (useVesktopState().screenshareQuality ??= {
        resolution: "720",
        frameRate: "30"
    });

    async function handlePair(code: string): Promise<boolean> {
        try {
            const res = (await VesktopNative.buteco.pair(code)) as ButecoResult<ButecoWireSession>;
            if (!res.ok) {
                setButecoError(res.error);
                return false;
            }

            latestButecoSession = res.value;
            setPaired(true);
            setButecoError(null);
            setLatestButecoError(null);
            return true;
        } catch {
            setButecoError({ code: "network", message: "Falha ao parear." });
            return false;
        }
    }

    function handleGoLive() {
        currentSettings = settings;
        try {
            const frameRate = Number(qualitySettings.frameRate);
            const height = Number(qualitySettings.resolution);
            const width = Math.round(height * (16 / 9));

            if (mode !== "buteco") {
                const conn = [...MediaEngineStore.getMediaEngine().connections].find(
                    connection => connection.streamUserId === UserStore.getCurrentUser().id
                );

                if (conn) {
                    conn.videoStreamParameters[0].maxFrameRate = frameRate;
                    conn.videoStreamParameters[0].maxResolution ??= { width: 0, height: 0 };
                    conn.videoStreamParameters[0].maxResolution.height = height;
                    conn.videoStreamParameters[0].maxResolution.width = width;
                }
            }

            submit({
                id: selected!,
                ...settings
            });

            setTimeout(async () => {
                if (mode === "buteco") return;

                const conn = [...MediaEngineStore.getMediaEngine().connections].find(
                    connection => connection.streamUserId === UserStore.getCurrentUser().id
                );
                if (!conn) return;

                // @ts-expect-error incorrect type
                const track = conn.input.stream.getVideoTracks()[0];

                const constraints = {
                    ...track.getConstraints(),
                    frameRate: { min: frameRate, ideal: frameRate },
                    width: { min: 640, ideal: width, max: width },
                    height: { min: 480, ideal: height, max: height },
                    advanced: [{ width: width, height: height }],
                    resizeMode: "none"
                };

                try {
                    await track.applyConstraints(constraints);

                    logger.info("Applied constraints successfully. New constraints:", track.getConstraints());
                } catch (e) {
                    logger.error("Failed to apply constraints.", e);
                }
            }, 100);
        } catch (error) {
            logger.error("Error while submitting stream.", error);
        }

        close();
    }

    // In Buteco mode the source is chosen inside the panel, so the two-step
    // Back/selection flow does not apply.
    const showGoBack = selected && !skipPicker && mode !== "buteco";
    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Screen Share Picker"
            actions={[
                {
                    text: showGoBack ? "Back" : "Cancel",
                    variant: "secondary",
                    onClick: () => (showGoBack ? setSelected(void 0) : close())
                },
                {
                    text: "Go Live",
                    // In Buteco mode the panel owns its own Iniciar action.
                    disabled: mode === "buteco" || !selected,
                    onClick: handleGoLive
                }
            ]}
        >
            <div className={cl("mode-toggle")}>
                {(["native", "buteco"] as const).map(m => (
                    <button
                        key={m}
                        type="button"
                        className={cl("mode-option")}
                        data-selected={mode === m}
                        aria-pressed={mode === m}
                        onClick={() => (Settings.butecoMode = m)}
                    >
                        {m === "native" ? "Native" : "Buteco Games"}
                    </button>
                ))}
            </div>

            {mode === "buteco" ? (
                <ButecoPanel
                    pick={butecoPick}
                    onPick={setButecoPick}
                    paired={paired}
                    onPair={handlePair}
                    error={butecoError}
                    onStart={() => {
                        if (!butecoPick) return;
                        submit({
                            id: "",
                            mode: "buteco",
                            contentHint: settings.contentHint,
                            audio: settings.audio,
                            ...butecoPick
                        } as StreamPick);
                        close();
                    }}
                />
            ) : !selected ? (
                <ScreenPicker screens={screens} chooseScreen={setSelected} />
            ) : (
                <StreamSettingsUi
                    source={screens.find(s => s.id === selected)!}
                    settings={settings}
                    setSettings={setSettings}
                    skipPicker={skipPicker}
                />
            )}
        </Modal>
    );
}
