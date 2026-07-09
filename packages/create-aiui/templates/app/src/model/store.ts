/**
 * store.ts — the durable roots of the app.
 *
 * Everything in this module survives a hot edit: the parameter signals (the
 * user's slider position is interaction state — the most precious thing in the
 * HMR contract), and later the engines, workers, canvases, and history rings a
 * real app grows. Each is created once through `durableSignal()` (or `durable()`
 * for anything that isn't a signal) and *adopted* by any re-evaluated module.
 *
 * The companion rule: this file is the guarded, rarely-edited wiring; the cell
 * graph (graph.ts) and the components (ui/) are the disposable logic edited
 * constantly. Splitting the two along module lines is what gives HMR an easy
 * job. Add new state HERE; add the dataflow over it in graph.ts.
 *
 * Note that editing this file forces a full reload — it is everything's
 * ancestor — so avoid it while a live run matters.
 */
import { durableSignal } from "@habemus-papadum/aiui-viz";

// --- parameters (durable interaction state) ---------------------------------
//
// Parameters a user can move — slider positions, selections, camera state —
// belong here, so a hot edit never resets what they touched.

/** Petal frequency n of the rose r = sin(n·θ). */
export const petals = durableSignal("param:petals", 6);
/** The Maurer walk's angle step d, in degrees. */
export const angleStep = durableSignal("param:angleStep", 71);

export const ANGLE_STEP_MIN = 1;
export const ANGLE_STEP_MAX = 179;
export const PETALS_MIN = 2;
export const PETALS_MAX = 9;
