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

import { control, scope } from "@habemus-papadum/aiui-viz";

/**
 * The app's instance scope: ONE slug qualifying every declaration — controls
 * ("regimes/petals"), durable keys, cells, actions — and naming the
 * graph key and the agent toolkit. Thread it through everything you declare
 * (`control({ scope: appScope, … })`, `appScope.durable(…)`,
 * `cell(deps, compute, { scope: appScope })`, `action({ scope: appScope, … })`):
 * it is what lets this app share a document with other aiui apps — mounted in
 * a gallery shell, or composed as a library — without colliding on the
 * window-global registries. See the user guide's "Composing bigger apps".
 */
export const appScope = scope("regimes");

// --- §1 · the two games (loaded die) ----------------------------------------

/** How loaded the die is: 0 = perfectly fair, 1 = always rolls ⚅. The die's
 * distribution is (1−L)·uniform + L·certainty on the last face. */
export const loadedness = control({ scope: appScope, value: 0.15, min: 0, max: 1, step: 0.01 });

/** How many rolls to simulate when scoring the two games. */
export const dieRolls = control({ scope: appScope, value: 1200, min: 100, max: 5000, step: 100 });

// --- §2–§4 · the regression simulator y = f(x) + σ·ε -------------------------

/** Noise level σ of the simulator: the standard deviation of the randomness
 * injected on top of the smooth truth f(x). The floor of any model is σ². */
export const noise = control({
  scope: appScope,
  value: 0.5,
  min: 0.05,
  max: 1.2,
  step: 0.05,
});

/** Sample size n: how many (x, y) pairs the fitted models get to see. */
export const samples = control({ scope: appScope, value: 80, min: 20, max: 500, step: 10 });

/** Polynomial degree of the model family — its expressiveness. The truth needs
 * about degree 12–14; below that the family simply cannot express f. */
export const degree = control({ scope: appScope, value: 6, min: 1, max: 14, step: 1 });

/** Ensemble size M: how many independently refit models get averaged in §4. */
export const members = control({ scope: appScope, value: 12, min: 2, max: 24, step: 1 });

/** Vary the family across ensemble members (degrees d−2 … d+2) instead of
 * refitting clones — widens the union of families AND decorrelates errors. */
export const heterogeneous = control({ scope: appScope, value: false });

// --- §5 · spectral bias -------------------------------------------------------

/** Target smoothness α: mode k of the target has amplitude k^(−α). 2 = very
 * smooth (energy in the coarse modes), 0 = white (all frequencies equally loud). */
export const smoothness = control({ scope: appScope, value: 1, min: 0, max: 2, step: 0.05 });

/** Training time, as log₁₀(t): scrub gradient descent through its whole run.
 * Mode k is learned on timescale k², so each +0.6 unlocks ~one more octave. */
export const trainTime = control({ scope: appScope, value: 1, min: -1, max: 4, step: 0.05 });

// --- §6 · horizon (chaos) -----------------------------------------------------

/** Measurement error of the initial state, as log₁₀(ε). Every −1 you buy only
 * adds ~3.3 steps of forecast: the horizon is logarithmic in precision. */
export const perturbation = control({ scope: appScope, value: -6, min: -12, max: -2, step: 0.5 });

// --- non-surface durable state ------------------------------------------------

/** Seed for every Monte-Carlo panel; the reseed action bumps it. */
export const seed = appScope.durableSignal("seed", 20260808);
