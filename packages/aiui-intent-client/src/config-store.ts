/**
 * config-store.ts — config persistence: AUTO-SAVE (owner, 2026-07-14).
 *
 * The session-layering verbs (save/reset) are gone: every control change
 * persists on its own, debounced a beat, and a reload starts from exactly
 * where you left off. Two pieces:
 *
 *  - `loadConfigBase()` — boot: apply the persisted values to the controls;
 *  - `installConfigAutoSave()` — boot, AFTER load: an effect over every
 *    persisted control's value that writes the store on any change (the
 *    order matters — installing first would persist factory defaults over
 *    the saved state before load ran).
 *
 * Writes go through each control's own `set` (validation included). The
 * key is `aiui2.config` — the coexistence namespace, away from the old
 * clients' storage.
 */

import type { ControlBox } from "@habemus-papadum/aiui-viz";
import { createEffect, createRoot, onCleanup } from "solid-js";
import * as config from "./config";

const BASE_KEY = "aiui2.config";

/** The persisted config surface (uiScale rides along — it is config too). */
const CONTROLS: Record<string, ControlBox<unknown>> = {
  stt: config.stt as ControlBox<unknown>,
  linter: config.linter as ControlBox<unknown>,
  videoPeriodSec: config.videoPeriodSec as ControlBox<unknown>,
  pencilFade: config.pencilFade as ControlBox<unknown>,
  shotFlash: config.shotFlash as ControlBox<unknown>,
  logLevel: config.logLevel as ControlBox<unknown>,
  uiScale: config.uiScale as ControlBox<unknown>,
};

function readBase(storage: Storage): Record<string, unknown> | undefined {
  try {
    const raw = storage.getItem(BASE_KEY);
    return raw === null ? undefined : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/** Apply the saved base (boot). No base = nothing to do. */
export function loadConfigBase(storage: Storage = localStorage): void {
  const base = readBase(storage);
  if (base === undefined) {
    return;
  }
  for (const [name, ctl] of Object.entries(CONTROLS)) {
    if (name in base) {
      try {
        ctl.set(base[name] as never);
      } catch {
        // a stale/invalid persisted value never blocks boot — skip it
      }
    }
  }
}

/**
 * Persist every control change, debounced (a slider drag is many writes; the
 * page going away flushes nothing it hasn't already written within the
 * debounce — 200 ms is well under any human open-to-close). Returns the
 * disposer. Effects read INSIDE the compute, so the effect re-runs on any
 * persisted control's change; the handler is the storage edge.
 */
export function installConfigAutoSave(
  storage: Storage = localStorage,
  debounceMs = 200,
): () => void {
  return createRoot((dispose) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    createEffect(
      () => {
        const snapshot: Record<string, unknown> = {};
        for (const [name, ctl] of Object.entries(CONTROLS)) {
          snapshot[name] = ctl.get();
        }
        return JSON.stringify(snapshot);
      },
      (serialized) => {
        clearTimeout(timer);
        timer = setTimeout(() => storage.setItem(BASE_KEY, serialized), debounceMs);
      },
    );
    onCleanup(() => clearTimeout(timer));
    return dispose;
  });
}
