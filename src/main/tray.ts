/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions, Tray } from "electron";

import { createAboutWindow } from "./about";
import { stopButecoPublish } from "./buteco";
import { butecoStore } from "./buteco/store";
import { AppEvents } from "./events";
import { Settings } from "./settings";
import { resolveAssetPath } from "./userAssets";
import { clearData } from "./utils/clearData";
import { downloadVencordFiles } from "./utils/vencordLoader";

let tray: Tray;
let trayVariant: "tray" | "trayUnread" = "tray";
let isQuittingRef: (val: boolean) => void = () => {};
let butecoUnsubscribe: (() => void) | null = null;

AppEvents.on("userAssetChanged", async asset => {
    if (tray && (asset === "tray" || asset === "trayUnread")) {
        tray.setImage(await resolveAssetPath(trayVariant));
    }
});

AppEvents.on("setTrayVariant", async variant => {
    if (trayVariant === variant) return;

    trayVariant = variant;
    if (!tray) return;

    tray.setImage(await resolveAssetPath(trayVariant));
});

export function destroyTray() {
    butecoUnsubscribe?.();
    butecoUnsubscribe = null;
    tray?.destroy();
}

/** Builds the tray menu; the Buteco stop item only exists while publishing. */
function buildTrayMenu(win: BrowserWindow): Menu {
    const { publishing } = butecoStore.getState();

    return Menu.buildFromTemplate([
        {
            label: "Open",
            click() {
                win.show();
            }
        },
        {
            label: "About",
            click: createAboutWindow
        },
        {
            label: "Repair Vencord",
            async click() {
                await downloadVencordFiles();
                app.relaunch();
                app.quit();
            }
        },
        {
            label: "Reset Vesktop",
            async click() {
                await clearData(win);
            }
        },
        ...(publishing
            ? ([
                  { type: "separator" },
                  {
                      label: "Parar compartilhamento Buteco",
                      click() {
                          void stopButecoPublish();
                      }
                  }
              ] satisfies MenuItemConstructorOptions[])
            : []),
        {
            type: "separator"
        },
        {
            label: "Restart",
            click() {
                app.relaunch();
                app.quit();
            }
        },
        {
            label: "Quit",
            click() {
                isQuittingRef(true);
                app.quit();
            }
        }
    ]);
}

function rebuildTrayMenu(win: BrowserWindow) {
    if (tray) tray.setContextMenu(buildTrayMenu(win));
}

export async function initTray(win: BrowserWindow, setIsQuitting: (val: boolean) => void) {
    const onTrayClick = () => {
        if (Settings.store.clickTrayToShowHide && win.isVisible()) win.hide();
        else win.show();
    };

    isQuittingRef = setIsQuitting;

    tray = new Tray(await resolveAssetPath(trayVariant));
    tray.setToolTip("Vesktop");
    tray.setContextMenu(buildTrayMenu(win));
    tray.on("click", onTrayClick);

    // Rebuild only when the publishing flag flips, so the stop item appears and
    // disappears with the Buteco stream.
    butecoUnsubscribe?.();
    let wasPublishing = butecoStore.getState().publishing;
    butecoUnsubscribe = butecoStore.subscribe(state => {
        if (state.publishing === wasPublishing) return;
        wasPublishing = state.publishing;
        rebuildTrayMenu(win);
    });
}
