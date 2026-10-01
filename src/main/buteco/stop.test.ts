/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { type ButecoStopDeps, createButecoStopper } from "./stop";
import { createButecoStore } from "./store";

function makeDeps(overrides: Partial<ButecoStopDeps> = {}) {
    const store = overrides.store ?? createButecoStore();
    const unpublish = vi.fn(async (_token: string) => ({ ok: false as const, error: { code: "network" as const } }));
    const broadcast = vi.fn();

    const deps: ButecoStopDeps = {
        store,
        getToken: () => "tok-1",
        unpublish,
        broadcast,
        ...overrides
    };

    return { deps, store, unpublish, broadcast };
}

describe("createButecoStopper", () => {
    it("no-ops when nothing is publishing", async () => {
        const { deps, unpublish, broadcast } = makeDeps();

        await createButecoStopper(deps).stop();

        expect(unpublish).not.toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
        expect(deps.store.getState().publishing).toBe(false);
    });

    it("unpublishes with the vault token and clears publishing", async () => {
        const { deps, store, unpublish } = makeDeps();
        store.setPublishing(true);

        await createButecoStopper(deps).stop();

        expect(unpublish).toHaveBeenCalledWith("tok-1");
        expect(store.getState().publishing).toBe(false);
        expect(store.getState().phase).toBe("idle");
    });

    it("clears publishing and still settles when the DELETE fails", async () => {
        const unpublish = vi.fn(async () => {
            throw new Error("ground down");
        });
        const { deps, store, broadcast } = makeDeps({ unpublish });
        store.setPublishing(true);

        await expect(createButecoStopper(deps).stop()).resolves.toBeUndefined();

        expect(store.getState().publishing).toBe(false);
        expect(store.getState().phase).toBe("idle");
        expect(broadcast).toHaveBeenCalledWith("stop");
    });

    it("emits the control:stop envelope", async () => {
        const { deps, store, broadcast } = makeDeps();
        store.setPublishing(true);

        await createButecoStopper(deps).stop();

        expect(broadcast).toHaveBeenCalledTimes(1);
        expect(broadcast).toHaveBeenCalledWith("stop");
    });

    it("hides the tray item and emits stop before the DELETE resolves", async () => {
        let release!: () => void;
        const pending = new Promise<void>(r => (release = r));
        const unpublish = vi.fn(async () => {
            await pending;
            return { ok: true as const, value: undefined };
        });
        const { deps, store, broadcast } = makeDeps({ unpublish });
        store.setPublishing(true);

        const done = createButecoStopper(deps).stop();

        // The synchronous part must have run before the network settles.
        expect(store.getState().publishing).toBe(false);
        expect(store.getState().phase).toBe("stopping");
        expect(broadcast).toHaveBeenCalledWith("stop");

        release();
        await done;
        expect(store.getState().phase).toBe("idle");
    });

    it("ignores a re-entrant click while a DELETE is in flight", async () => {
        let release!: () => void;
        const pending = new Promise<void>(r => (release = r));
        const unpublish = vi.fn(async () => {
            await pending;
            return { ok: true as const, value: undefined };
        });
        const { deps, store, broadcast } = makeDeps({ unpublish });
        store.setPublishing(true);
        const stopper = createButecoStopper(deps);

        const first = stopper.stop();
        await stopper.stop(); // second click while hung
        release();
        await first;

        expect(unpublish).toHaveBeenCalledTimes(1);
        expect(broadcast).toHaveBeenCalledTimes(1);
        expect(store.getState().phase).toBe("idle");
    });

    it("releases the re-entry guard when broadcast throws", async () => {
        const unpublish = vi.fn(async () => ({ ok: true as const, value: undefined }));
        const broadcast = vi.fn(() => {
            throw new Error("webContents.send failed");
        });
        const { deps, store } = makeDeps({ unpublish, broadcast });
        const stopper = createButecoStopper(deps);

        store.setPublishing(true);
        await expect(stopper.stop()).resolves.toBeUndefined();
        expect(unpublish).toHaveBeenCalledTimes(1);

        // The guard must have been released: a later publish can be stopped again.
        store.setPublishing(true);
        await stopper.stop();

        expect(unpublish).toHaveBeenCalledTimes(2);
        expect(store.getState().publishing).toBe(false);
        expect(store.getState().phase).toBe("idle");
    });

    it("clears publishing and releases the guard when a store subscriber throws", async () => {
        const store = createButecoStore();
        const unpublish = vi.fn(async () => ({ ok: true as const, value: undefined }));
        const { deps } = makeDeps({ store, unpublish });
        const stopper = createButecoStopper(deps);

        // Simulate a tray rebuild (subscriber) throwing on the synchronous flip.
        store.subscribe(state => {
            if (state.phase === "stopping") throw new Error("tray rebuild failed");
        });

        store.setPublishing(true);
        await expect(stopper.stop()).resolves.toBeUndefined();

        expect(store.getState().publishing).toBe(false);
        expect(unpublish).toHaveBeenCalledTimes(1);

        // State was applied before the throwing subscriber, so a later stop works.
        store.setPublishing(true);
        await stopper.stop();
        expect(unpublish).toHaveBeenCalledTimes(2);
    });
});
