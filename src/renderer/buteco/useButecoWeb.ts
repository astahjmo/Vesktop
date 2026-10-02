/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./cameraTiles";
import "./viewer";

import { onceReady } from "@vencord/types/webpack";
import { useEffect, useState } from "@vencord/types/webpack/common";
import type { ButecoWebEnvelope, ButecoWebState } from "shared/butecoWeb";

import { applyButecoWebEnvelope, getButecoWebState, subscribeButecoWeb } from "./webState";

onceReady.then(() => {
    VesktopNative.buteco.web.onEvent(envelope => applyButecoWebEnvelope(envelope as ButecoWebEnvelope));
    void VesktopNative.buteco.web.status();
});

/** Estado da sessão/salas; assina o envelope uma única vez por processo. */
export function useButecoWebState(): ButecoWebState {
    const [state, setState] = useState(getButecoWebState());

    useEffect(() => {
        setState(getButecoWebState());
        return subscribeButecoWeb(() => setState(getButecoWebState()));
    }, []);

    return state;
}
