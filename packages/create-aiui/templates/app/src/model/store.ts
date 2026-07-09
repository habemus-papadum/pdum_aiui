/**
 * store.ts — the durable roots of the app.
 *
 * Everything in this module survives a hot edit: the parameter signals (the
 * user's slider position is interaction state — the most precious thing in
 * the HMR contract) and the current keyboard mode. All of it lives in the
 * durable registry (durable, from @habemus-papadum/aiui-viz), created once
 * and *adopted* by any re-evaluated module.
 *
 * The companion rule: this file is the guarded, rarely-edited wiring; the
 * cell graph (graph.ts), the modal shell (modal.ts), and the components (ui/)
 * are the disposable logic edited constantly. Splitting the two along module
 * lines is what gives HMR an easy job. Add new state HERE; add new dataflow
 * over it in graph.ts.
 */
import { durable } from "@habemus-papadum/aiui-viz";
import { type Accessor, createSignal, type Setter } from "solid-js";

function signalBox<T>(
  key: string,
  // biome-ignore lint/complexity/noBannedTypes: mirrors createSignal's own Exclude<T, Function> overload
  initial: Exclude<T, Function>,
): { get: Accessor<T>; set: Setter<T> } {
  return durable(key, () => {
    const [get, set] = createSignal<T>(initial);
    return { get, set };
  });
}

// --- parameters (durable interaction state) ---------------------------------

/** Petal frequency n of the rose r = sin(n·θ). Cycled with the R key. */
export const petals = signalBox("param:petals", 6);
/** The Maurer walk's angle step d, in degrees — the slider. */
export const angleStep = signalBox("param:angleStep", 71);

export const ANGLE_STEP_MIN = 1;
export const ANGLE_STEP_MAX = 179;
export const PETALS_MIN = 2;
export const PETALS_MAX = 9;

// --- the keyboard mode (see modal.ts for the table that governs it) ----------

export type Mode = "view" | "tune";
export const mode = signalBox<Mode>("mode", "view");
