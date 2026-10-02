/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./autoRoomRelease";

import {
    closeModal,
    ContextMenuApi,
    Menu,
    Modal,
    openModal,
    useEffect,
    useRef,
    useState
} from "@vencord/types/webpack/common";
import {
    type ButecoPick,
    getLatestButecoError,
    setLatestButecoError,
    startButecoPublish,
    stopActiveButeco
} from "renderer/components/ScreenSharePicker";
import type { ButecoError } from "shared/buteco";

import { ButecoPanel } from "./ButecoPanel";
import { disableButecoCamera, enableButecoCamera, useButecoCameraState } from "./cameraSession";
import { isPublishStarting, setPublishPhase } from "./publishProgress";
import { useButecoPublishing } from "./publishState";
import { ensureButecoRoom, leaveAutoCreatedRoom } from "./room";
import { useButecoWebState } from "./useButecoWeb";

/** Cervejinha: ícone do Buteco Games. */
const BEER_PATH =
    "M5 8V7a2.5 2.5 0 0 1 2.2-2.5A3 3 0 0 1 12 3.3a3 3 0 0 1 4.6 1.2A2.5 2.5 0 0 1 17 7v1H5ZM5 10h12v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-9Zm3.2 2.5v6h1.6v-6H8.2Zm4 0v6h1.6v-6h-1.6ZM17 11h1.5a2.5 2.5 0 0 1 2.5 2.5v2a2.5 2.5 0 0 1-2.5 2.5H17v-1.8h1.5a.7.7 0 0 0 .7-.7v-2a.7.7 0 0 0-.7-.7H17V11Z";

const CAMERA_PATH =
    "M4 5H14C15.105 5 16 5.895 16 7V9.5L21 6.5V17.5L16 14.5V17C16 18.105 15.105 19 14 19H4C2.895 19 2 18.105 2 17V7C2 5.895 2.895 5 4 5Z";

const STYLE_ID = "vc-buteco-button-styles";

/**
 * Com os dois botões do Buteco a linha compacta do painel de voz passa de 5 para
 * 6 itens. Os botões do Discord têm padding lateral fixo e o ícone é o que
 * encolhe; tiramos o padding lateral e apertamos o espaçamento só nessa linha.
 */
function ensureButecoButtonStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        [class*="actionButtons_"] { gap: 4px !important; }
        [class*="actionButtons_"] button { padding-inline: 0 !important; min-width: 0 !important; }
        .vc-buteco-tray-btn:hover:not(:disabled) { background: rgba(151, 151, 159, 0.16); }
    `;
    document.head.appendChild(style);
}

/**
 * Visual dos botões vizinhos: na linha compacta copiamos a classe de um botão
 * nativo (mesmo fundo, raio e hover do Discord); na barra grande usamos o
 * formato dela (40x40, sem fundo).
 */
function useNativeLook() {
    const ref = useRef<HTMLButtonElement>(null);
    const [look, setLook] = useState<{ compact: boolean; nativeClass: string | null }>({
        compact: false,
        nativeClass: null
    });

    useEffect(() => {
        ensureButecoButtonStyles();

        const parent = ref.current?.parentElement;
        if (!parent) return;

        const compact = /actionButtons_/.test(parent.className);
        const native = compact
            ? parent.querySelector<HTMLElement>('button[class*="buttonColor_"]:not(.vc-buteco-btn)')
            : null;
        setLook({ compact, nativeClass: native?.className ?? null });
    }, []);

    return { ref, ...look };
}

function butecoButtonProps(
    look: { compact: boolean; nativeClass: string | null },
    color: string | undefined,
    id: "call" | "camera"
) {
    const native = look.compact && look.nativeClass;

    return {
        className: [`vc-buteco-btn vc-buteco-${id}-button`, native ? look.nativeClass : "vc-buteco-tray-btn"].join(" "),
        style: {
            position: "relative" as const,
            color,
            ...(native
                ? {}
                : {
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: look.compact ? 32 : 40,
                      height: look.compact ? 32 : 40,
                      padding: 0,
                      border: "none",
                      borderRadius: 8,
                      cursor: "pointer",
                      background: look.compact ? "rgba(151, 151, 159, 0.12)" : "transparent",
                      color: color ?? "var(--interactive-normal, currentColor)"
                  })
        }
    };
}

function ButecoIcon({ path, evenodd }: { path: string; evenodd?: boolean }) {
    return (
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24">
            <path fill="currentColor" fillRule={evenodd ? "evenodd" : undefined} d={path} />
        </svg>
    );
}

function LiveDot() {
    return (
        <span
            aria-hidden="true"
            style={{
                position: "absolute",
                right: 3,
                bottom: 3,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--status-positive, #23a55a)",
                boxShadow: "0 0 0 2px var(--background-base-low, #2b2d31)"
            }}
        />
    );
}

/**
 * A Discord-styled call-tray control for the Buteco share. While idle it opens
 * the standalone panel (login, room, source, quality and audio). While live it
 * turns green and opens a menu to switch the shared source — which republishes,
 * stopping the previous stream first — or to stop sharing. It never touches
 * Discord's Go Live path, so it keeps working when screensharing is restricted
 * in a region.
 */
export function ButecoCallButton() {
    const publishing = useButecoPublishing();
    const look = useNativeLook();
    const green = publishing ? "var(--status-positive, #23a55a)" : undefined;

    return (
        <button
            ref={look.ref}
            type="button"
            aria-label={publishing ? "Buteco Games — transmitindo" : "Buteco Games"}
            aria-pressed={publishing}
            title={publishing ? "Buteco Games — transmitindo" : "Buteco Games"}
            {...butecoButtonProps(look, green, "call")}
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
        >
            <ButecoIcon path={BEER_PATH} evenodd />
            {publishing ? <LiveDot /> : null}
        </button>
    );
}

/**
 * Liga/desliga a câmera do Buteco na sala aberta, direto da barra da chamada.
 * Sem login ou sem sala abre o painel para entrar primeiro.
 */
export function ButecoCameraButton() {
    const camera = useButecoCameraState();
    const web = useButecoWebState();
    const look = useNativeLook();

    const label = camera.enabled ? "Desligar câmera do Buteco" : "Ligar câmera do Buteco";
    const color = camera.enabled
        ? "var(--status-positive, #23a55a)"
        : camera.error
          ? "var(--status-danger, #f23f43)"
          : undefined;
    const props = butecoButtonProps(look, color, "camera");

    return (
        <button
            ref={look.ref}
            type="button"
            aria-label={label}
            aria-pressed={camera.enabled}
            title={camera.error ?? label}
            disabled={camera.busy}
            {...props}
            style={{ ...props.style, opacity: camera.busy ? 0.6 : 1, cursor: camera.busy ? "progress" : "pointer" }}
            onClick={() => {
                if (camera.enabled) void disableButecoCamera();
                else if (!web.status.loggedIn) openButecoModal();
                else void enableButecoCamera();
            }}
        >
            <ButecoIcon path={CAMERA_PATH} />
            {camera.enabled ? <LiveDot /> : null}
        </button>
    );
}

/** Botões do Buteco na barra: transmissão de tela + câmera. */
export function ButecoCallButtons() {
    return (
        <>
            <ButecoCallButton />
            <ButecoCameraButton />
        </>
    );
}

/**
 * Opens the Buteco panel in a standalone modal: login, room, source, quality
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
    const [error, setError] = useState<ButecoError | null>(() => getLatestButecoError());

    async function onStart() {
        // Clicar de novo enquanto negocia só repetiria o pedido: o botão já está travado.
        if (!pick || isPublishStarting()) return;
        setPublishPhase({ step: "room" });

        try {
            // Sem sala aberta, cria uma com nome aleatório e sem senha.
            const room = await ensureButecoRoom({ exclusive: true });
            if (!room.ok) {
                setError(room.error);
                return;
            }

            const res = await startButecoPublish(pick);
            if (!res.ok) {
                setError(res.error);
                // A sala nasceu só para esta transmissão: não deixa uma mesa vazia aberta.
                void leaveAutoCreatedRoom();
            } else {
                setLatestButecoError(null);
                modalProps.onClose();
            }
        } finally {
            setPublishPhase({ step: "idle" });
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
                {
                    text: "Cancelar",
                    variant: "secondary",
                    onClick: () => {
                        // Cancelar no meio da negociação também interrompe a transmissão que estava subindo.
                        if (isPublishStarting()) void stopActiveButeco();
                        modalProps.onClose();
                    }
                }
            ]}
        >
            <ButecoPanel pick={pick} onPick={setPick} error={error} session={null} onStart={onStart} />
        </Modal>
    );
}
