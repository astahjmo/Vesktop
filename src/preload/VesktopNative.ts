/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Node } from "@vencord/venmic";
import { ipcRenderer } from "electron/renderer";
import type { ButecoWireSession } from "main/buteco/store";
import type { IpcMessage, IpcResponse } from "main/ipcCommands";
import type { ButecoIceServer, ButecoResult } from "shared/buteco";
import type { ButecoRoomSummary, ButecoSfuOp, ButecoWebEnvelope, ButecoWebStatus } from "shared/butecoWeb";
import type { Settings } from "shared/settings";

import { IpcEvents } from "../shared/IpcEvents";
import { invoke, sendSync } from "./typedIpc";

type SpellCheckerResultCallback = (word: string, suggestions: string[]) => void;

const spellCheckCallbacks = new Set<SpellCheckerResultCallback>();

ipcRenderer.on(IpcEvents.SPELLCHECK_RESULT, (_, w: string, s: string[]) => {
    spellCheckCallbacks.forEach(cb => cb(w, s));
});

let onDevtoolsOpen = () => {};
let onDevtoolsClose = () => {};

ipcRenderer.on(IpcEvents.DEVTOOLS_OPENED, () => onDevtoolsOpen());
ipcRenderer.on(IpcEvents.DEVTOOLS_CLOSED, () => onDevtoolsClose());

export const VesktopNative = {
    app: {
        relaunch: () => invoke<void>(IpcEvents.RELAUNCH),
        getVersion: () => sendSync<void>(IpcEvents.GET_VERSION),
        setBadgeCount: (count: number) => invoke<void>(IpcEvents.SET_BADGE_COUNT, count),
        supportsWindowsTransparency: () => sendSync<boolean>(IpcEvents.SUPPORTS_WINDOWS_TRANSPARENCY),
        getEnableHardwareAcceleration: () => sendSync<boolean>(IpcEvents.GET_ENABLE_HARDWARE_ACCELERATION),
        isOutdated: () => invoke<boolean>(IpcEvents.UPDATER_IS_OUTDATED),
        openUpdater: () => invoke<void>(IpcEvents.UPDATER_OPEN),
        // used by vencord
        getRendererCss: () => invoke<string>(IpcEvents.GET_VESKTOP_RENDERER_CSS),
        onRendererCssUpdate: (cb: (newCss: string) => void) => {
            if (!IS_DEV) return;

            ipcRenderer.on(IpcEvents.VESKTOP_RENDERER_CSS_UPDATE, (_e, newCss: string) => cb(newCss));
        }
    },
    autostart: {
        isEnabled: () => sendSync<boolean>(IpcEvents.AUTOSTART_ENABLED),
        enable: () => invoke<void>(IpcEvents.ENABLE_AUTOSTART),
        disable: () => invoke<void>(IpcEvents.DISABLE_AUTOSTART)
    },
    fileManager: {
        isUsingCustomVencordDir: () => sendSync<boolean>(IpcEvents.IS_USING_CUSTOM_VENCORD_DIR),
        showCustomVencordDir: () => invoke<void>(IpcEvents.SHOW_CUSTOM_VENCORD_DIR),
        selectVencordDir: (value?: null) => invoke<"cancelled" | "invalid" | "ok">(IpcEvents.SELECT_VENCORD_DIR, value),
        chooseUserAsset: (asset: string, value?: null) =>
            invoke<"cancelled" | "invalid" | "ok" | "failed">(IpcEvents.CHOOSE_USER_ASSET, asset, value)
    },
    settings: {
        get: () => sendSync<Settings>(IpcEvents.GET_SETTINGS),
        set: (settings: Settings, path?: string) => invoke<void>(IpcEvents.SET_SETTINGS, settings, path)
    },
    spellcheck: {
        getAvailableLanguages: () => sendSync<string[]>(IpcEvents.SPELLCHECK_GET_AVAILABLE_LANGUAGES),
        onSpellcheckResult(cb: SpellCheckerResultCallback) {
            spellCheckCallbacks.add(cb);
        },
        offSpellcheckResult(cb: SpellCheckerResultCallback) {
            spellCheckCallbacks.delete(cb);
        },
        replaceMisspelling: (word: string) => invoke<void>(IpcEvents.SPELLCHECK_REPLACE_MISSPELLING, word),
        addToDictionary: (word: string) => invoke<void>(IpcEvents.SPELLCHECK_ADD_TO_DICTIONARY, word)
    },
    win: {
        focus: () => invoke<void>(IpcEvents.FOCUS),
        close: (key?: string) => invoke<void>(IpcEvents.CLOSE, key),
        minimize: (key?: string) => invoke<void>(IpcEvents.MINIMIZE, key),
        maximize: (key?: string) => invoke<void>(IpcEvents.MAXIMIZE, key),
        flashFrame: (flag: boolean) => invoke<void>(IpcEvents.FLASH_FRAME, flag),
        setDevtoolsCallbacks: (onOpen: () => void, onClose: () => void) => {
            onDevtoolsOpen = onOpen;
            onDevtoolsClose = onClose;
        }
    },
    capturer: {
        getLargeThumbnail: (id: string) => invoke<string>(IpcEvents.CAPTURER_GET_LARGE_THUMBNAIL, id)
    },
    buteco: {
        // Only the narrow methods this task wires are typed; the rest of the
        // namespace (listSources, refreshIce, ...) keeps its loose typing for the
        // later typing pass. `onEvent`'s envelope (`{ state, event? }`) is owned
        // by that same task.
        pair: (code: string) => invoke<ButecoResult<ButecoWireSession>>(IpcEvents.BUTECO_PAIR, code),
        unpair: () => invoke(IpcEvents.BUTECO_UNPAIR),
        armCapture: (sourceId: string) => invoke<void>(IpcEvents.BUTECO_ARM_CAPTURE, sourceId),
        cancelCapture: () => invoke<void>(IpcEvents.BUTECO_CANCEL_CAPTURE),
        listSources: () => invoke(IpcEvents.BUTECO_LIST_SOURCES),
        publish: (offerSdp: string, meta: unknown) => invoke(IpcEvents.BUTECO_PUBLISH, offerSdp, meta),
        unpublish: () => invoke(IpcEvents.BUTECO_UNPUBLISH),
        refreshIce: () => invoke(IpcEvents.BUTECO_REFRESH_ICE),
        onEvent: (cb: (envelope: unknown) => void) => {
            ipcRenderer.on(IpcEvents.BUTECO_EVENT, (_e, envelope) => cb(envelope));
        },
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
            whep: (sdp: string) => invoke<ButecoResult<{ sdp: string }>>(IpcEvents.BUTECO_WEB_WHEP, sdp),
            sfu: (op: ButecoSfuOp, payload?: Record<string, unknown>) =>
                invoke<ButecoResult<any>>(IpcEvents.BUTECO_WEB_SFU, op, payload),
            onEvent: (cb: (envelope: ButecoWebEnvelope) => void) => {
                ipcRenderer.on(IpcEvents.BUTECO_WEB_EVENT, (_e, envelope) => cb(envelope));
            }
        }
    },
    /** only available on Linux. */
    virtmic: {
        list: () =>
            invoke<
                { ok: false; isGlibCxxOutdated: boolean } | { ok: true; targets: Node[]; hasPipewirePulse: boolean }
            >(IpcEvents.VIRT_MIC_LIST),
        start: (include: Node[]) => invoke<void>(IpcEvents.VIRT_MIC_START, include),
        startSystem: (exclude: Node[]) => invoke<void>(IpcEvents.VIRT_MIC_START_SYSTEM, exclude),
        unmute: () => invoke<void>(IpcEvents.VIRT_MIC_UNMUTE),
        stop: () => invoke<void>(IpcEvents.VIRT_MIC_STOP)
    },
    clipboard: {
        copyImage: (imageBuffer: Uint8Array, imageSrc: string) =>
            invoke<void>(IpcEvents.CLIPBOARD_COPY_IMAGE, imageBuffer, imageSrc)
    },
    debug: {
        launchGpu: () => invoke<void>(IpcEvents.DEBUG_LAUNCH_GPU),
        launchWebrtcInternals: () => invoke<void>(IpcEvents.DEBUG_LAUNCH_WEBRTC_INTERNALS)
    },
    commands: {
        onCommand(cb: (message: IpcMessage) => void) {
            ipcRenderer.on(IpcEvents.IPC_COMMAND, (_, message) => cb(message));
        },
        respond: (response: IpcResponse) => ipcRenderer.send(IpcEvents.IPC_COMMAND, response)
    }
};
