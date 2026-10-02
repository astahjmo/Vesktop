/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ButecoRoomQuality } from "shared/butecoWeb";

/** Camada de simulcast (`h` = alta, `l` = baixa), como o site monta os slots do SFU. */
export interface SfuLayer {
    rid: "h" | "l";
    scaleResolutionDownBy: number;
    maxBitrateKbps: number;
    maxFramerate: number;
}

export interface SfuPreset {
    capture: { width: number; height: number; frameRate: number };
    layers: SfuLayer[];
}

/** Câmera: preset da sala (`economica` / `alta`). */
export const CAMERA_PRESETS: Record<ButecoRoomQuality, SfuPreset> = {
    economica: {
        capture: { width: 640, height: 360, frameRate: 20 },
        layers: [
            { rid: "h", scaleResolutionDownBy: 1, maxBitrateKbps: 450, maxFramerate: 20 },
            { rid: "l", scaleResolutionDownBy: 2, maxBitrateKbps: 120, maxFramerate: 12 }
        ]
    },
    alta: {
        capture: { width: 1280, height: 720, frameRate: 24 },
        layers: [
            { rid: "h", scaleResolutionDownBy: 1, maxBitrateKbps: 1200, maxFramerate: 24 },
            { rid: "l", scaleResolutionDownBy: 4, maxBitrateKbps: 200, maxFramerate: 15 }
        ]
    }
};

type ScreenHeight = 480 | 720 | 1080;

/** Bitrates da tela (modo "mídia" do site): `${altura}:${fps}` → kbps alto/baixo e fps baixo. */
const SCREEN_RATES: Record<string, { highKbps: number; lowKbps: number; lowFps: number }> = {
    "1080:30": { highKbps: 3000, lowKbps: 700, lowFps: 24 },
    "1080:60": { highKbps: 4500, lowKbps: 1000, lowFps: 30 },
    "720:30": { highKbps: 2000, lowKbps: 500, lowFps: 24 },
    "720:60": { highKbps: 3000, lowKbps: 750, lowFps: 30 },
    "480:30": { highKbps: 1000, lowKbps: 300, lowFps: 24 },
    "480:60": { highKbps: 1500, lowKbps: 400, lowFps: 30 }
};

function normalizeHeight(height: number): ScreenHeight {
    if (height >= 1080) return 1080;
    if (height >= 720) return 720;
    return 480;
}

/** Preset do slot de tela para a altura/fps escolhidos (1440p usa o perfil de 1080p, com mais bitrate). */
export function screenPreset(height: number, fps: number): SfuPreset {
    const normalized = normalizeHeight(height);
    const frameRate = fps >= 60 ? 60 : 30;
    const rates = SCREEN_RATES[`${normalized}:${frameRate}`];
    const boost = height > 1080 ? 1.5 : 1;

    return {
        capture: { width: Math.round((normalized * 16) / 9 / 2) * 2, height: normalized, frameRate },
        layers: [
            {
                rid: "h",
                scaleResolutionDownBy: 1,
                maxBitrateKbps: Math.round(rates.highKbps * boost),
                maxFramerate: frameRate
            },
            { rid: "l", scaleResolutionDownBy: 2, maxBitrateKbps: rates.lowKbps, maxFramerate: rates.lowFps }
        ]
    };
}

export function encodingsFor(preset: SfuPreset): RTCRtpEncodingParameters[] {
    return preset.layers.map(layer => ({
        rid: layer.rid,
        scaleResolutionDownBy: layer.scaleResolutionDownBy,
        maxBitrate: layer.maxBitrateKbps * 1000,
        maxFramerate: layer.maxFramerate
    }));
}
