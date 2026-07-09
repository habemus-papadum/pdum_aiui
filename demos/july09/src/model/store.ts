/**
 * store.ts — the durable roots of the app.
 *
 * Everything in this module survives a hot edit. It is the guarded,
 * rarely-edited wiring: engines, workers, canvases, history rings, and every
 * user parameter, each created once through `durableSignal()` (or `durable()`
 * for anything that isn't a signal) and *adopted* by any re-evaluated module.
 * The cell graph (graph.ts) and the components (ui/) are the disposable logic
 * edited constantly. Splitting the two along module lines is what gives HMR an
 * easy job.
 *
 * It is empty. Add new state HERE; add the dataflow over it in graph.ts:
 *
 *   import { durableSignal } from "@habemus-papadum/aiui-viz";
 *   export const sampleId = durableSignal("param:sampleId", "A1");
 *
 * Note that editing this file forces a full reload — it is everything's
 * ancestor — so avoid it while a live run matters.
 */

// --- parameters (durable interaction state) ---------------------------------
//
// Parameters a user can move — slider positions, selections, camera state —
// belong here as durableSignal()s, so a hot edit never resets what they touched.

export {};
