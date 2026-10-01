/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { closeModal, ContextMenuApi, Menu, Modal, openModal, useState } from "@vencord/types/webpack/common";
import {
    type ButecoPick,
    getLatestButecoError,
    getLatestButecoSession,
    pairButeco,
    setLatestButecoError,
    startButecoPublish,
    stopActiveButeco
} from "renderer/components/ScreenSharePicker";
import type { ButecoError } from "shared/buteco";

import { ButecoPanel } from "./ButecoPanel";
import { isRepairErrorCode } from "./messages";
import { useButecoPublishing } from "./publishState";

/**
 * A Discord-styled call-tray control for the Buteco share. While idle it opens
 * the standalone panel (pair, pick a source, quality and audio). While live it
 * turns green and opens a menu to switch the shared source — which republishes,
 * stopping the previous stream first — or to stop sharing. It never touches
 * Discord's Go Live path, so it keeps working when screensharing is restricted
 * in a region.
 */
export function ButecoCallButton() {
    const publishing = useButecoPublishing();

    return (
        <button
            type="button"
            className="vc-buteco-call-button"
            aria-label={publishing ? "Buteco Games — transmitindo" : "Buteco Games"}
            aria-pressed={publishing}
            title={publishing ? "Buteco Games — transmitindo" : "Buteco Games"}
            onClick={event => {
                if (!publishing) {
                    openButecoModal();
                    return;
                }

                ContextMenuApi.openContextMenu(event, () => (
                    <Menu.Menu
                        navId="vc-buteco-stream-menu"
                        onClose={() => ContextMenuApi.closeContextMenu()}
                        aria-label="Buteco Games"
                    >
                        <Menu.MenuItem id="vc-buteco-switch" label="Trocar janela" action={() => openButecoModal()} />
                        <Menu.MenuItem
                            id="vc-buteco-stop"
                            label="Parar transmissão"
                            color="danger"
                            action={() => void stopActiveButeco()}
                        />
                    </Menu.Menu>
                ));
            }}
            style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 32,
                height: 32,
                padding: 0,
                margin: "0 4px",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                color: publishing ? "var(--status-positive, #23a55a)" : "var(--interactive-normal, currentColor)",
                background: "var(--background-primary, transparent)"
            }}
        >
            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24">
                <path
                    fill="currentColor"
                    d="M2 4.5C2 3.397 2.897 2.5 4 2.5H20C21.103 2.5 22 3.397 22 4.5V15.5C22 16.604 21.103 17.5 20 17.5H13V19.5H17V21.5H7V19.5H11V17.5H4C2.897 17.5 2 16.604 2 15.5V4.5ZM4 4.5V15.5H20V4.5H4Z"
                />
            </svg>
            {publishing ? (
                <span
                    aria-hidden="true"
                    style={{
                        position: "absolute",
                        right: 2,
                        bottom: 2,
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "var(--status-positive, #23a55a)",
                        boxShadow: "0 0 0 2px var(--background-primary, #313338)"
                    }}
                />
            ) : null}
        </button>
    );
}

/**
 * Opens the Buteco panel in a standalone modal: pair, pick a source, quality
 * and audio, then publish — all without Discord's Go Live. Reopening it while a
 * stream is live republishes with the newly picked source (the controller stops
 * the previous stream first).
 */
export function openButecoModal() {
    const key = openModal(props => <ButecoModal modalProps={props} />, {
        onCloseRequest() {
            closeModal(key);
        }
    });
}

function ButecoModal({ modalProps }: { modalProps: any }) {
    const [pick, setPick] = useState<ButecoPick | null>(null);
    const [paired, setPaired] = useState(() => getLatestButecoSession() !== null);
    const [error, setError] = useState<ButecoError | null>(() => getLatestButecoError());
    const [needsRepair, setNeedsRepair] = useState(() => isRepairErrorCode(getLatestButecoError()?.code));

    async function onPair(code: string): Promise<boolean> {
        const res = await pairButeco(code);
        if (!res.ok) {
            setError(res.error);
            if (isRepairErrorCode(res.error.code)) setNeedsRepair(true);
            return false;
        }
        setPaired(true);
        setError(null);
        setNeedsRepair(false);
        return true;
    }

    async function onStart() {
        if (!pick) return;
        const res = await startButecoPublish(pick);
        if (!res.ok) {
            setError(res.error);
        } else {
            setLatestButecoError(null);
            modalProps.onClose();
        }
    }

    async function onStop() {
        await stopActiveButeco();
    }

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Buteco Games"
            actions={[
                { text: "Parar", variant: "secondary", onClick: onStop },
                { text: "Cancelar", variant: "secondary", onClick: () => modalProps.onClose() }
            ]}
        >
            <ButecoPanel
                pick={pick}
                onPick={setPick}
                paired={paired}
                onPair={onPair}
                error={error}
                needsRepair={needsRepair}
                session={getLatestButecoSession()}
                onStart={onStart}
            />
        </Modal>
    );
}
