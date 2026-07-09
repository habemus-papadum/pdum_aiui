// <aiui-scenery-file> — this WHOLE FILE is placeholder scenery: delete it on reset (CLAUDE.md § Reset).
/**
 * scenery.ts — the starter's demo dataflow (playbook layer 2, scenery edition).
 *
 * Everything the placeholder rose needs above the pure math: its cell, and the
 * agent tools that expose its parameters. It is packaged as one module so the
 * rest of the app touches it in exactly three fenced lines (an import, a
 * spread, a register call in graph.ts) — which is what makes the reset to a
 * blank canvas a mechanical deletion instead of a refactor.
 *
 * When you build your real app, you won't have a scenery.ts: your cells go
 * straight into graph.ts's builder (or into per-feature modules shaped like
 * this one, if the graph grows big enough to want splitting).
 */
import { type AgentToolkit, type Cell, cell } from "@habemus-papadum/aiui-viz";
import { buildRose, type Rose } from "./rose";
import { ANGLE_STEP_MAX, ANGLE_STEP_MIN, angleStep, PETALS_MAX, PETALS_MIN, petals } from "./store";

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
    ),
  };
}

/** The scenery's tool twins: every operation the sliders offer, callable. */
export function registerSceneryTools(kit: AgentToolkit): void {
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
}
