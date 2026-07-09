/**
 * graph.ts — the cell graph (every dataflow in the app, notebook-style) and
 * the agent tool surface, in one place.
 *
 * This module is *disposable logic*. `hotCellGraph` builds the graph from the
 * durable roots in store.ts and, on a hot edit, disposes the old graph and
 * swaps in a new one — the sliders keep their positions and every cell
 * recomputes from the roots. Components read `graph().rose` through the stable
 * accessor it returns, so they can never hold a stale cell reference.
 *
 * The starter has exactly one cell (the rose is instant to compute — the cell
 * is here for the discipline: attribution stamps, registry, CellView chrome).
 * When your real app arrives, this is where its fetches, workers, and derived
 * data go: `cell(deps, compute)` handles aborts, progress, and streaming —
 * see the docs (frontend-user-guide) and the gallery demo for worked examples.
 */
import {
  agentToolkit,
  type Cell,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { buildRose, type Rose } from "./rose";
import { ANGLE_STEP_MAX, ANGLE_STEP_MIN, angleStep, PETALS_MAX, PETALS_MIN, petals } from "./store";

export interface AppGraph {
  /** The picture, recomputed whenever a parameter moves. */
  rose: Cell<Rose>;
}

// --- the graph: rebuilt over the durable roots on every hot edit --------------

/** The current graph — a stable accessor that survives hot swaps. */
export const graph = hotCellGraph<AppGraph>(
  "app",
  () => ({
    // async on purpose, cheap as the math is: a cell's compute is where
    // fetches and workers will go, and the async path is what gives CellView
    // its contract (a value only ever appears once the run has produced it).
    rose: cell(
      () => ({ petals: petals.get(), step: angleStep.get() }),
      async (params) => buildRose(params),
    ),
  }),
  // Passed, not read here: `import.meta.hot` is bound to THIS module, and a
  // library can't self-accept on our behalf. See hotCellGraph's docs.
  import.meta.hot,
);

// --- agent tools: the app's operations, exposed as they are built ---------------
//
// Every operation a user can perform should have a tool twin, so the agent
// (your future self) can drive and inspect the app instead of guessing at it.
// Register each one next to the capability it exposes. Registration is
// idempotent by name, so a hot edit replaces rather than duplicates.

const kit = agentToolkit("app");

// `locate` (element → source) and the `cells` attribution table: app-independent,
// and every aiui app should have them.
registerStandardTools(kit);

kit.registerTool({
  name: "get-params",
  description: "Current rose parameters (petal frequency n, angle step d).",
  run: () => ({ petals: petals.get(), step: angleStep.get() }),
});

kit.registerTool({
  name: "set-params",
  description: "Set rose parameters. The sliders follow; the picture reacts immediately.",
  params: {
    petals: `petal frequency, integer ${PETALS_MIN}..${PETALS_MAX}`,
    step: `angle step in degrees, integer ${ANGLE_STEP_MIN}..${ANGLE_STEP_MAX}`,
  },
  run: (args) => {
    // Return what was written, not a fresh read: Solid 2.0 commits signal
    // writes transactionally, so a same-scope .get() still sees old values.
    const next = { petals: petals.get(), step: angleStep.get() };
    if (typeof args?.petals === "number") {
      next.petals = Math.round(Math.min(PETALS_MAX, Math.max(PETALS_MIN, args.petals)));
      petals.set(next.petals);
    }
    if (typeof args?.step === "number") {
      next.step = Math.round(Math.min(ANGLE_STEP_MAX, Math.max(ANGLE_STEP_MIN, args.step)));
      angleStep.set(next.step);
    }
    return next;
  },
});

kit.registerReporter("params", () => ({ petals: petals.get(), step: angleStep.get() }));
