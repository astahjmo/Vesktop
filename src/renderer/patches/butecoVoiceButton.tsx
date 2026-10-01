/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ButecoCallButton } from "renderer/buteco/VoicePanelButton";

import { addPatch } from "./shared";

/**
 * Injects a standalone "Buteco Games" button into both of Discord's voice
 * control rows:
 *
 * 1. The compact voice panel in the sidebar (the row with camera / screen /
 *    activity / soundboard).
 * 2. The full-screen call control tray (`CenterControlTray`).
 *
 * It opens the Buteco share panel directly and never goes through Discord's
 * Go Live, so it still works when screensharing is restricted in a region.
 *
 * The anchors key off distinctive JSX prop combinations; if Discord changes
 * either shape the match simply fails and no button is added — the rest of
 * the client is unaffected.
 */
addPatch({
    patches: [
        {
            // Compact sidebar voice panel row.
            find: /className:\i\.\i,children:\[(?=\(0,\i\.jsx\)\(\i,\{channel:\i,enableActivities:)/,
            replacement: {
                match: /className:\i\.\i,children:\[(?=\(0,\i\.jsx\)\(\i,\{channel:\i,enableActivities:)/,
                replace: "$&$self.renderButecoButton(),"
            },
            noWarn: true
        },
        {
            // Full-screen call control tray, right before the Go Live button.
            find: "CenterControlTray: currentUser cannot be undefined",
            replacement: {
                match: /children:\[(?=!\i&&\(0,\i\.jsx\)\(\i,\{channel:\i,currentUser:\i,exitFullScreen:)/,
                replace: "children:[$self.renderButecoButton(),"
            },
            noWarn: true
        }
    ],

    renderButecoButton() {
        return <ButecoCallButton />;
    }
});
