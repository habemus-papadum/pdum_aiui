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

import { oscillatorStore } from "@habemus-papadum/aiui-oscillator";
import { scope } from "@habemus-papadum/aiui-viz";

// ── two instances of ONE slice — the composability demo ──────────────────────
//
// `oscillatorStore` is a reusable slice factory from a workspace library
// (demos/oscillator). The explicit Scope is what makes two instances
// possible at all: each gets qualified identity ("left/freq", "right/freq")
// and its own durable state. Without the scope, both would silently share one
// control (same call site → same injected leaf name → same durable key).

export const leftScope = scope("left");
export const rightScope = scope("right");

export const left = oscillatorStore(leftScope);
export const right = oscillatorStore(rightScope);
