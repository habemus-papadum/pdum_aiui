/**
 * config-store.ts — session layering, plain-page grade (the overlay's
 * config-strip semantics, adopted per the owner's DECIDE default).
 *
 * The LIVE control values are the session layer (durable across hot edits,
 * gone on reload); the SAVED BASE lives in localStorage. Three verbs:
 *
 *  - `loadConfigBase()`  — boot: apply the saved base to the controls (a
 *    reload starts from what you saved, not factory defaults);
 *  - `saveConfigBase()`  — S: the current values become the base;
 *  - `resetConfigToBase()` — R: discard session changes, restore the base
 *    (factory defaults when nothing was ever saved).
 *
 * Writes go through each control's own `set` (validation included). The
 * key is `aiui2.config` — the coexistence namespace, away from the old
 * clients' storage.
 */

import type { ControlBox } from "@habemus-papadum/aiui-viz";
import { flush } from "solid-js";
import * as config from "./config";

const BASE_KEY = "aiui2.config";

/** The persisted config surface (uiScale rides along — it is config too). */
const CONTROLS: Record<string, ControlBox<unknown>> = {
  stt: config.stt as ControlBox<unknown>,
  linter: config.linter as ControlBox<unknown>,
  videoPeriodSec: config.videoPeriodSec as ControlBox<unknown>,
  inkVanish: config.inkVanish as ControlBox<unknown>,
  inkFade: config.inkFade as ControlBox<unknown>,
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

/** The current values become the saved base (S). */
export function saveConfigBase(storage: Storage = localStorage): void {
  // A boundary that must OBSERVE writes: the caller may have set a control
  // in this very tick ("move the slider, hit save"), and a boundary read
  // before the commit would snapshot the PRE-write value (write-semantics
  // M0). flush() is the sanctioned cure (M2): commit, then read.
  flush();
  const snapshot: Record<string, unknown> = {};
  for (const [name, ctl] of Object.entries(CONTROLS)) {
    snapshot[name] = ctl.get();
  }
  storage.setItem(BASE_KEY, JSON.stringify(snapshot));
}

/** Discard session changes: restore the base, or factory defaults (R). */
export function resetConfigToBase(storage: Storage = localStorage): void {
  const base = readBase(storage);
  for (const [name, ctl] of Object.entries(CONTROLS)) {
    const value = base !== undefined && name in base ? base[name] : ctl.initial;
    try {
      ctl.set(value as never);
    } catch {
      ctl.set(ctl.initial as never);
    }
  }
}
