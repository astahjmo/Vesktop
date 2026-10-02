/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@vencord/types/webpack/common";

import { getPublishPhase, type PublishPhase, subscribePublishPhase } from "./publishProgress";

/** Hook React da fase do início da transmissão (a lógica pura fica em `publishProgress.ts`). */
export function usePublishPhase(): PublishPhase {
    const [value, setValue] = useState(getPublishPhase());

    useEffect(() => {
        setValue(getPublishPhase());
        return subscribePublishPhase(() => setValue(getPublishPhase()));
    }, []);

    return value;
}
