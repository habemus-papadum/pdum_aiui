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
 * ("dna-script/petals"), durable keys, cells, actions — and naming the
 * graph key and the agent toolkit. Thread it through everything you declare
 * (`control({ scope: appScope, … })`, `appScope.durable(…)`,
 * `cell(deps, compute, { scope: appScope })`, `action({ scope: appScope, … })`):
 * it is what lets this app share a document with other aiui apps — mounted in
 * a gallery shell, or composed as a library — without colliding on the
 * window-global registries. See the user guide's "Composing bigger apps".
 */
export const appScope = scope("dna-script");

// --- the strand on the bench --------------------------------------------------

/** The strand, written 5'→3'. Characters that are not A, C, G or T are ignored,
 *  so pasting text with spaces, digits or a FASTA header still works — whatever
 *  was dropped is reported rather than silently swallowed. */
export const sequence = control({ scope: appScope, value: "GAATTC" });

/** Turn the partner strand 180°. Off, the partner is written the ordinary way
 *  (its own 5'→3', left to right) and nothing lines up. On, it is that same
 *  strand turned end over end — and the edges mesh. This toggle IS the claim
 *  the notation is making, so it is the first thing to reach for. */
export const rotatePartner = control({ scope: appScope, value: true });

/** Print the letter above each glyph. Handy while learning the shapes; turn it
 *  off to read the strand as pure symbology. */
export const showLetters = control({ scope: appScope, value: true });

// --- folding -------------------------------------------------------------------

/** Fewest unpaired bases a hairpin loop may hold. A real strand cannot turn
 *  round in less than about three, so raising this forbids tight turns and
 *  pushes the fold toward longer loops. */
export const minLoop = control({ scope: appScope, value: 3, min: 2, max: 9, step: 1 });

/** Shortest helix worth keeping. Maximum-pairing loves isolated single pairs
 *  that stack on nothing; at 2 or more they are discarded and what remains
 *  reads as actual helices. */
export const minHelix = control({ scope: appScope, value: 2, min: 1, max: 4, step: 1 });

/** Draw the fold at this cell height, px — the folded diagram needs more room
 *  than the flat duplex, so it gets its own size. */
export const foldSize = control({
  scope: appScope,
  value: 26,
  min: 12,
  max: 54,
  step: 1,
  unit: "px",
});

// --- how the notation is set --------------------------------------------------

/** Height of one base cell — the notation's type size. */
export const glyphSize = control({
  scope: appScope,
  value: 38,
  min: 16,
  max: 76,
  step: 1,
  unit: "px",
});
