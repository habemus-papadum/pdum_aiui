/**
 * store.ts — the lab app's durable frontier: a small standing-wave bench,
 * scoped under `oracle-lab`. Names and descriptions are compiler-injected
 * (the aiui plugin lifts the binding + doc comment); the toolkit registers
 * the standard page tools so the intent client sees this page too.
 */

import {
  action,
  agentToolkit,
  control,
  registerStandardTools,
  scope,
} from "@habemus-papadum/aiui-viz";

export const labScope = scope("oracle-lab");

/** Wave frequency — how many crests fit the window. */
export const freq = control({ scope: labScope, value: 2, min: 0.5, max: 8, step: 0.5, unit: "Hz" });

/** Wave amplitude, as a fraction of the panel's half-height. */
export const amplitude = control({ scope: labScope, value: 0.6, min: 0.1, max: 1, step: 0.05 });

/** How fast a kick's ripple dies out (0 = rings forever-ish). */
export const damping = control({ scope: labScope, value: 0.4, min: 0, max: 1, step: 0.05 });

/** The waveform family. */
export const waveform = control({
  scope: labScope,
  value: "sine",
  options: ["sine", "square", "saw"],
});

/** Reference grid on/off. */
export const grid = control({ scope: labScope, value: true });

/** The kick's impulse clock — the renderer decays it (module state, not a
 * cell: transient animation bookkeeping, deliberately undurable). */
export const kickState = { at: 0 };

/** Give the wave a kick — a decaying amplitude ripple. */
export const kick = action({
  scope: labScope,
  run: () => {
    kickState.at = performance.now();
    return "kicked";
  },
});

const kit = agentToolkit(labScope.name);
registerStandardTools(kit);
