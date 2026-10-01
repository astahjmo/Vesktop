/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, HeadingTertiary, Paragraph } from "@vencord/types/components";
import { useAwaiter } from "@vencord/types/utils";
import { useState } from "@vencord/types/webpack/common";
import type { ButecoPick } from "renderer/components/ScreenSharePicker";
import type { ButecoSource } from "shared/buteco";

export function ButecoPanel({
    pick,
    onPick,
    onStart,
    paired,
    onPair
}: {
    pick: ButecoPick | null;
    onPick: (p: ButecoPick) => void;
    onStart: () => void;
    paired: boolean;
    onPair: (code: string) => Promise<boolean>;
}) {
    const [code, setCode] = useState("");
    const [pairing, setPairing] = useState(false);
    const [pairFailed, setPairFailed] = useState(false);
    const [sources] = useAwaiter<ButecoSource[]>(() => VesktopNative.buteco.listSources(), {
        fallbackValue: [],
        deps: []
    });

    async function handlePair() {
        if (pairing) return;
        setPairing(true);
        setPairFailed(false);
        try {
            setPairFailed(!(await onPair(code)));
        } finally {
            setPairing(false);
        }
    }

    if (!paired) {
        return (
            <div>
                <HeadingTertiary>Conectar ao Buteco Games</HeadingTertiary>
                <Paragraph>Informe o código de pareamento exibido na sala do Buteco.</Paragraph>
                <input
                    value={code}
                    onChange={e => setCode(e.currentTarget.value)}
                    placeholder="CÓDIGO"
                    disabled={pairing}
                />
                <Button disabled={pairing || !code} onClick={handlePair}>
                    {pairing ? "Pareando..." : "Parear"}
                </Button>
                {pairFailed ? <Paragraph>Código inválido ou falha de rede. Tente novamente.</Paragraph> : null}
            </div>
        );
    }

    return (
        <div>
            <HeadingTertiary>Fonte</HeadingTertiary>
            <div>
                {sources.map(s => (
                    <button
                        key={s.id}
                        type="button"
                        data-selected={pick?.sourceId === s.id}
                        onClick={() =>
                            onPick({
                                sourceId: s.id,
                                videoKind: s.kind,
                                videoLabel: s.name,
                                height: pick?.height ?? 1080,
                                fps: pick?.fps ?? 30,
                                mic: pick?.mic ?? true
                            })
                        }
                    >
                        {s.thumbnailDataUrl ? <img src={s.thumbnailDataUrl} alt="" /> : null}
                        {s.name}
                    </button>
                ))}
            </div>
            <Button disabled={!pick} onClick={onStart}>
                Iniciar
            </Button>
        </div>
    );
}
