/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { fileURLToPath } from "url";

import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            shared: fileURLToPath(new URL("./src/shared", import.meta.url))
        }
    },
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"]
    }
});
