/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
    describePhase,
    getPublishPhase,
    isPublishStarting,
    setPublishPhase,
    subscribePublishPhase
} from "./publishProgress";

describe("publish progress", () => {
    beforeEach(() => setPublishPhase({ step: "idle" }));

    it("tells whether a start is in progress and notifies subscribers", () => {
        const seen: string[] = [];
        const unsubscribe = subscribePublishPhase(() => seen.push(getPublishPhase().step));

        expect(isPublishStarting()).toBe(false);
        setPublishPhase({ step: "capture" });
        expect(isPublishStarting()).toBe(true);
        setPublishPhase({ step: "idle" });
        unsubscribe();
        setPublishPhase({ step: "room" });

        expect(seen).toEqual(["capture", "idle"]);
    });

    it("describes each phase in Portuguese, flagging a fallback attempt", () => {
        expect(describePhase({ step: "idle" })).toBe("");
        expect(describePhase({ step: "room" })).toContain("sala");
        expect(describePhase({ step: "capture" })).toContain("captura");
        expect(describePhase({ step: "connecting", transport: "cloudflare", attempt: 1, total: 2 })).toBe(
            "Conectando pelo Cloudflare…"
        );
        expect(describePhase({ step: "connecting", transport: "mediamtx", attempt: 2, total: 2 })).toContain(
            "Tentando outro caminho"
        );
        // Uma única tentativa nunca é "outro caminho".
        expect(describePhase({ step: "connecting", transport: "mediamtx", attempt: 1, total: 1 })).toContain(
            "Conectando"
        );
    });
});
