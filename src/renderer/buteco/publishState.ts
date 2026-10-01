/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@vencord/types/webpack/common";

/**
 * Whether this client is currently publishing to the Buteco Ground. Kept at
 * module scope because the widget that shows the stop/switch controls and the
 * picker that starts/stops the stream are different components.
 */
let publishing = false;
const listeners = new Set<() => void>();

export function isButecoPublishing(): boolean {
    return publishing;
}

export function setButecoPublishing(value: boolean): void {
    if (publishing === value) return;

    publishing = value;
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            // A broken subscriber must not block the others.
        }
    }
}

export function subscribeButecoPublishing(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Reactive view of the publish state for the voice-panel control. */
export function useButecoPublishing(): boolean {
    const [value, setValue] = useState(publishing);

    useEffect(() => {
        setValue(isButecoPublishing());
        return subscribeButecoPublishing(() => setValue(isButecoPublishing()));
    }, []);

    return value;
}
