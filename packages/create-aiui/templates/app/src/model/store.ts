/**
 * store.ts — the durable roots of the app (the state side of playbook layer 2),
 * and where the **control surface** is declared: the independent variables a
 * user moves through widgets and an agent moves through the derived `set` tool.
 *
 * `control({ value, … })` needs no name and no description here — the aiui
 * compiler injects the name from the binding and lifts the description from
 * the doc comment above it (so write real doc comments: they become the editor
 * tooltip AND the agent-facing registry text). Constraints (`min`/`max`/`step`/
 * `unit`/`options`) live in the declaration, and every write — slider,
 * keyboard, agent — validates through them in one place. Controls are durable:
 * a hot edit never resets what the user set; renaming a binding DOES reset its
 * state (pass an explicit `{ name }` to rename without that).
 *
 * State that is NOT part of the surface (engines, workers, canvases, history
 * rings, transient bookkeeping) uses `durableSignal()`/`durable()` instead —
 * the surface is curated, not automatic.
 *
 * The companion rule: this file is the guarded, rarely-edited wiring; the cell
 * graph (graph.ts) and the components (ui/) are the disposable logic edited
 * constantly. Note that editing this file forces a full reload — it is
 * everything's ancestor — so avoid it while a live run matters.
 */

import { scope } from "@habemus-papadum/aiui-viz";

/**
 * The app's instance scope: ONE slug qualifying every declaration — controls
 * ("__APP_NAME__/petals"), durable keys, cells, actions — and naming the
 * graph key and the agent toolkit. Thread it through everything you declare
 * (`control({ scope: appScope, … })`, `appScope.durable(…)`,
 * `cell(deps, compute, { scope: appScope })`, `action({ scope: appScope, … })`):
 * it is what lets this app share a document with other aiui apps — mounted in
 * a gallery shell, or composed as a library — without colliding on the
 * window-global registries. See the user guide's "Composing bigger apps".
 */
export const appScope = scope("__APP_NAME__");

// <aiui-scenery>
import { control } from "@habemus-papadum/aiui-viz";

/** Petal frequency n of the rose r = sin(n·θ). */
export const petals = control({ scope: appScope, value: 6, min: 2, max: 9, step: 1 });

/** The Maurer walk's angle step d, in degrees. */
export const angleStep = control({
  scope: appScope,
  value: 71,
  min: 1,
  max: 179,
  step: 1,
  unit: "°",
});
// </aiui-scenery>
