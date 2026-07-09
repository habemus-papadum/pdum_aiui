/**
 * graph.ts — the cell graph (every dataflow in the app, notebook-style) and
 * the agent tool surface, in one place.
 *
 * This module is *disposable logic*. It builds the graph from the durable
 * roots in store.ts, publishes it through a durable box (a stable signal the
 * UI subscribes to), and on a hot edit disposes the old graph and swaps in a
 * new one — the slider keeps its position and every cell recomputes from the
 * roots. The UI never holds a stale cell reference because it reads the box,
 * not a module export.
 *
 * The starter has exactly one cell (the rose is instant to compute — the cell
 * is here for the discipline: attribution stamps, registry, CellView chrome).
 * When your real app arrives, this is where its fetches, workers, and derived
 * data go: `cell(deps, compute)` handles aborts, progress, and streaming —
 * see the docs (frontend-for-agents) and the morphogen demo for worked
 * examples.
 */
import {
  agentToolkit,
  type Cell,
  cell,
  cellGraph,
  cellRegistry,
  durable,
} from "@habemus-papadum/aiui-viz";
import { createSignal } from "solid-js";
import { buildRose, type Rose } from "./rose";
import { ANGLE_STEP_MAX, ANGLE_STEP_MIN, angleStep, PETALS_MAX, PETALS_MIN, petals } from "./store";

export interface AppGraph {
  /** The picture, recomputed whenever a parameter moves. */
  rose: Cell<Rose>;
}

// --- the durable box the UI subscribes to ------------------------------------

const graphBox = durable("graphBox", () => {
  const [get, set] = createSignal<{ graph: AppGraph; dispose: () => void }>();
  return { get, set };
});

/** The current graph — a stable accessor that survives hot swaps. */
export const appGraph = (): AppGraph | undefined => graphBox.get()?.graph;

// --- graph construction --------------------------------------------------------

function build(): { graph: AppGraph; dispose: () => void } {
  const { graph, dispose } = cellGraph(() => {
    // async on purpose, cheap as the math is: a cell's compute is where
    // fetches and workers will go, and the async path is what gives CellView
    // its contract (a value only ever appears once the run has produced it).
    const rose = cell(
      () => ({ petals: petals.get(), step: angleStep.get() }),
      async (params) => buildRose(params),
    );
    return { rose } satisfies AppGraph;
  });
  return { graph, dispose };
}

// --- agent tools: the app's operations, exposed as they are built ---------------
//
// Every operation a user can perform should have a tool twin, so the agent
// (your future self) can drive and inspect the app instead of guessing at it.

function registerTools(): void {
  const { registerTool, registerReporter } = agentToolkit("app");
  registerTool({
    name: "get-params",
    description: "Current rose parameters (petal frequency n, angle step d).",
    run: () => ({ petals: petals.get(), step: angleStep.get() }),
  });
  registerTool({
    name: "set-params",
    description: "Set rose parameters. The slider follows; the picture reacts immediately.",
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
  registerTool({
    name: "locate",
    description:
      "Map DOM elements to their source locations (compile-time data-source-loc stamps). Combine with window.__AIUI__.sourceRoot for absolute paths.",
    params: { selector: "CSS selector; first 20 matches returned" },
    run: (args) => {
      const sel = String(args?.selector ?? "*");
      return [...document.querySelectorAll(sel)].slice(0, 20).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").trim().slice(0, 40),
        source: el.closest("[data-source-loc]")?.getAttribute("data-source-loc") ?? null,
        cell: el.closest("[data-cell]")?.getAttribute("data-cell") ?? null,
      }));
    },
  });
  // The attribution table: every live named cell, its state, and where it is
  // defined — names match the data-cell stamps in the DOM.
  registerReporter("cells", () => cellRegistry());
  registerReporter("params", () => ({ petals: petals.get(), step: angleStep.get() }));
}

// --- module evaluation = (re)build ----------------------------------------------

graphBox.get()?.dispose(); // an HMR re-evaluation swaps the previous graph out
graphBox.set(build());
registerTools(); // idempotent by name — re-registration replaces
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    console.info("[app:hmr] graph module reloaded — cells rebuilt over durable roots");
  });
}
