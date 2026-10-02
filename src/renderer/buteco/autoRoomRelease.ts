/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getButecoCameraState, subscribeButecoCamera } from "./cameraSession";
import { isButecoPublishing, subscribeButecoPublishing } from "./publishState";
import { getAutoCreatedRoomId, leaveAutoCreatedRoom } from "./room";

/**
 * A sala criada automaticamente não tem dono humano esperando: quando a tela e
 * a câmera estão paradas, o app sai dela (e o servidor a fecha) em vez de
 * deixar uma mesa vazia aberta no lobby.
 */
const IDLE_GRACE_MS = 2500;

let timer: ReturnType<typeof setTimeout> | null = null;
/** Só libera depois que algo esteve ativo: nunca logo após criar a sala. */
let wasBusy = false;

function busy(): boolean {
    const camera = getButecoCameraState();
    return isButecoPublishing() || camera.enabled || camera.busy;
}

function check() {
    if (timer) clearTimeout(timer);
    timer = null;

    if (busy()) {
        wasBusy = true;
        return;
    }
    if (!wasBusy || !getAutoCreatedRoomId()) return;
    wasBusy = false;

    timer = setTimeout(() => {
        timer = null;
        if (!busy()) void leaveAutoCreatedRoom();
    }, IDLE_GRACE_MS);
}

subscribeButecoPublishing(check);
subscribeButecoCamera(check);
