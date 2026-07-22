// <aiui-scenery-file> — this WHOLE FILE is placeholder scenery: delete it on reset (CLAUDE.md § Reset).
/**
 * scenery.ts — the starter's demo dataflow (playbook layer 2, scenery edition).
 *
 * Everything the placeholder rose needs above the pure math: its cell, and one
 * `action()` — a registered verb. It is packaged as one module so the rest of
 * the app touches it in exactly two fenced lines (an import and a spread in
 * graph.ts) — which is what makes the reset to a blank canvas a mechanical
 * deletion instead of a refactor.
 *
 * Note what is NOT here: no get-params/set-params tools. The controls declared
 * in store.ts and the action below surface to the agent automatically through
 * `registerStandardTools` (report/set + one real tool per action) — declaring
 * IS exposing.
 *
 * When you build your real app, you won't have a scenery.ts: your cells and
 * actions go straight into graph.ts's builder (or per-feature modules shaped
 * like this one, if the graph grows big enough to want splitting).
 */
import { action, type Cell, cell } from "@habemus-papadum/aiui-viz";
import { buildRose, type Rose } from "./rose";
import { angleStep, appScope, petals } from "./store";

// Re-exported for the library barrel (index.ts): the barrel's scenery block
// must reference ONLY scenery modules, so a reset can delete it mechanically —
// an `export … from "./model/store"` line there would get merged by the import
// organizer with the unfenced appScope export and break the invariant.
export { angleStep, petals } from "./store";

export interface SceneryCells {
  /** The picture, recomputed whenever a parameter moves. */
  rose: Cell<Rose>;
}

/** The scenery's cells; graph.ts folds these into the app graph with a spread. */
export function sceneryCells(): SceneryCells {
  return {
    // async on purpose, cheap as the math is: a cell's compute is where
    // fetches and workers will go, and the async path is what gives CellView
    // its contract (a value only ever appears once the run has produced it).
    rose: cell(
      () => ({ petals: petals.get(), step: angleStep.get() }),
      async (params) => buildRose(params),
      { scope: appScope },
    ),
  };
}

/** Jump both parameters to a fresh random flower. */
action({
  scope: appScope,
  name: "re-flower",
  run: () => {
    // Writes validate through each control's own meta — no clamping here.
    const next = {
      petals: petals.set(2 + Math.floor(Math.random() * 8)),
      step: angleStep.set(1 + Math.floor(Math.random() * 179)),
    };
    // Return what was written, never a re-read: writes are batched.
    return next;
  },
});
