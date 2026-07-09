/**
 * graph.ts — the cell graph: every asynchronous dataflow in the app, in one
 * place, notebook-style.
 *
 * This module is *disposable logic*. It builds the graph from the durable
 * roots in store.ts, publishes it through a durable box (a stable signal the
 * UI subscribes to), and on a hot edit disposes the old graph and swaps in a
 * new one — the sim keeps running, sliders keep their positions, history
 * keeps its rows, and every cell recomputes from those roots. That is the
 * "graph is disposable, roots are durable" pattern; the UI never holds a
 * stale cell reference because it reads the box, not the module export.
 *
 * The agent tools are registered here too, next to the capabilities they
 * expose — the tool surface accumulates as the app grows (agentToolkit, from
 * @habemus-papadum/aiui-viz).
 */

import {
  agentToolkit,
  type Cell,
  cell,
  cellGraph,
  cellRegistry,
  durable,
  fromWorker,
} from "@habemus-papadum/aiui-viz";
import { type Accessor, createEffect, createSignal, untrack } from "solid-js";
import type { AnalysisParams, AnalysisResult } from "../analysis/analysis.worker";
import { REGIME_CATALOG, type Regime } from "./regime-data";
import {
  analysisWorker,
  autoAnalyze,
  DIFFUSION,
  failNextFetch,
  history,
  paramF,
  paramK,
  quality,
  sim,
  snapshot,
  speed,
  threshold,
} from "./store";

export interface MorphoGraph {
  /** The regime catalog, arriving through a simulated slow download. */
  catalog: Cell<Regime[]>;
  /** Heavy structure analysis of a captured field (worker; cancellable). */
  analysis: Cell<AnalysisResult>;
  /** Capture the live field and (re)run the analysis on it. */
  captureAnalysis(): void;
  /** Abort any in-flight analysis and hold until the next capture. */
  cancelAnalysis(): void;
  /** Re-download the catalog (bump the attempt counter). */
  reloadCatalog(): void;
  /** ms epoch of the last field capture, if any. */
  capturedAt: Accessor<number | undefined>;
}

// --- the durable box the UI subscribes to ------------------------------------

const graphBox = durable("graphBox", () => {
  const [get, set] = createSignal<{ graph: MorphoGraph; dispose: () => void }>();
  return { get, set };
});

/** The current graph — a stable accessor that survives hot swaps. */
export const morphoGraph = (): MorphoGraph | undefined => graphBox.get()?.graph;

// --- graph construction -------------------------------------------------------

function build(): { graph: MorphoGraph; dispose: () => void } {
  return (() => {
    const { graph, dispose } = cellGraph(() => {
      // ---- parameters flow INTO the imperative sim island ------------------
      createEffect(
        () => ({ F: paramF.get(), k: paramK.get() }),
        (p) => sim.engine.setParams({ ...p, ...DIFFUSION }),
      );
      createEffect(speed.get, (s) => sim.loop.setSpeed(s));

      // ---- the regime catalog: a slow, cancellable, retryable download ------
      const [attempt, setAttempt] = createSignal(1);
      const catalog = cell(
        () => ({ attempt: attempt() }),
        async function* (_a, ctx): AsyncGenerator<Regime[], void, void> {
          const failPlanned = untrack(failNextFetch.get);
          // Consume the flag outside the owned scope (prologue writes throw).
          if (failPlanned) queueMicrotask(() => failNextFetch.set(false));
          let received: Regime[] = [];
          const chunk = 2;
          for (let i = 0; i < REGIME_CATALOG.length; i += chunk) {
            await new Promise((r) => setTimeout(r, 160));
            if (ctx.signal.aborted) return;
            const fraction = (i + chunk) / REGIME_CATALOG.length;
            if (failPlanned && fraction > 0.4) {
              throw new Error("simulated network failure — hit Retry to re-download");
            }
            ctx.progress(Math.min(1, fraction));
            received = [...received, ...REGIME_CATALOG.slice(i, i + chunk)];
            yield received; // the table fills in as "packets" arrive
          }
        },
      );

      // ---- heavy structure analysis in the worker ---------------------------
      const [capture, setCapture] = createSignal<
        { field: Float32Array; width: number; height: number; at: number } | undefined
      >(undefined);
      const analysis = cell(() => {
        const c = capture();
        if (!c) return undefined; // hold until something is captured
        // threshold/quality are read reactively: moving either slider
        // supersedes the in-flight run (worker gets a cancel) and re-runs
        // on the same captured field.
        return {
          field: c.field,
          width: c.width,
          height: c.height,
          threshold: threshold.get(),
          quality: quality.get(),
          at: c.at,
        } satisfies AnalysisParams & { at: number };
      }, fromWorker<AnalysisParams, AnalysisResult>(analysisWorker));

      const captureAnalysis = () => {
        const grab = sim.loop.captureField();
        setCapture({ ...grab, at: Date.now() });
      };
      const cancelAnalysis = () => setCapture(undefined);

      // Auto-capture: re-analyze on a cadence while the option is on and the
      // previous run has settled — the "data updated on a loop propagates
      // through the system" path, gated so the worker never piles up.
      let sinceCapture = 0;
      createEffect(snapshot.get, () => {
        if (!untrack(autoAnalyze.get)) return;
        sinceCapture++;
        if (sinceCapture >= 14 && untrack(analysis.settled)) {
          sinceCapture = 0;
          captureAnalysis();
        }
      });

      return {
        catalog,
        analysis,
        captureAnalysis,
        cancelAnalysis,
        reloadCatalog: () => setAttempt((a) => a + 1),
        capturedAt: () => capture()?.at,
      } satisfies MorphoGraph;
    });
    return { graph, dispose };
  })();
}

// --- agent tools: the app's operations, exposed as they are built -------------

function registerTools(): void {
  const { registerTool, registerReporter } = agentToolkit("morpho");
  registerTool({
    name: "get-params",
    description: "Current simulation parameters and speed.",
    run: () => ({
      F: paramF.get(),
      k: paramK.get(),
      speed: speed.get(),
      threshold: threshold.get(),
      quality: quality.get(),
    }),
  });
  registerTool({
    name: "set-params",
    description: "Set Gray-Scott parameters. Sliders update; the sim reacts immediately.",
    params: { F: "feed rate 0.0..0.1", k: "kill rate 0.03..0.08" },
    run: (args) => {
      // Return the values written, not a re-read: Solid 2.0 batches writes
      // transactionally, so a same-tick .get() can still show the old value.
      const next = { F: paramF.get(), k: paramK.get() };
      if (typeof args?.F === "number") {
        next.F = args.F;
        paramF.set(next.F);
      }
      if (typeof args?.k === "number") {
        next.k = args.k;
        paramK.set(next.k);
      }
      return next;
    },
  });
  registerTool({
    name: "jump-regime",
    description: "Jump to a named regime from the catalog (see report().catalog).",
    params: { id: "regime id, e.g. 'mitosis'" },
    run: (args) => {
      const regime = REGIME_CATALOG.find((r) => r.id === args?.id);
      if (!regime) {
        throw new Error(
          `unknown regime "${String(args?.id)}" — ids: ${REGIME_CATALOG.map((r) => r.id).join(", ")}`,
        );
      }
      paramF.set(regime.F);
      paramK.set(regime.k);
      return regime;
    },
  });
  registerTool({
    name: "set-speed",
    description: "Simulation steps per frame; 0 pauses.",
    params: { value: "integer 0..60" },
    run: (args) => {
      let value = speed.get();
      if (typeof args?.value === "number") {
        value = args.value;
        speed.set(value);
      }
      return { speed: value };
    },
  });
  registerTool({
    name: "reseed",
    description: "Reinitialize the field.",
    params: { kind: "'center' | 'spots' | 'noise' | 'clear'" },
    run: (args) => {
      const kind = (args?.kind ?? "center") as "center" | "spots" | "noise" | "clear";
      sim.engine.seed(kind);
      history.clear();
      return { seeded: kind };
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
        // Which dataflow node produced the values rendered here (nearest
        // data-cell boundary); resolve details via report().cells.
        cell: el.closest("[data-cell]")?.getAttribute("data-cell") ?? null,
      }));
    },
  });
  registerTool({
    name: "analyze",
    description: "Capture the current field and run the structure analysis.",
    run: () => {
      morphoGraph()?.captureAnalysis();
      return { started: true };
    },
  });
  // The attribution table: every live named cell, its state, and where it is
  // defined — names match the data-cell stamps in the DOM.
  registerReporter("cells", () => cellRegistry());
  registerReporter("sim", () => ({
    ...sim.loop.stats(),
    steps: sim.engine.steps,
    params: { F: paramF.get(), k: paramK.get(), speed: speed.get() },
  }));
  registerReporter("observables", () => snapshot.get());
  registerReporter("history", () => {
    const rows = history.rows;
    return { length: rows.length, latest: rows.slice(-5) };
  });
  registerReporter("analysis", () => {
    const g = morphoGraph();
    if (!g) return { state: "no graph" };
    const a = g.analysis;
    const value = a.latest();
    return {
      state: a.state(),
      progress: a.progress(),
      capturedAt: g.capturedAt(),
      summary: value
        ? {
            phase: value.phase,
            spots: value.census.count,
            meanArea: Math.round(value.census.meanArea),
            wavelength: value.wavelength,
            elapsedMs: Math.round(value.elapsedMs),
          }
        : undefined,
    };
  });
  registerReporter("catalog", () => {
    const g = morphoGraph();
    if (!g) return { state: "no graph" };
    return {
      state: g.catalog.state(),
      regimes: g.catalog.latest()?.map((r) => r.id) ?? [],
    };
  });
}

// --- module evaluation = (re)build --------------------------------------------

graphBox.get()?.dispose(); // an HMR re-evaluation swaps the previous graph out
graphBox.set(build());
registerTools(); // idempotent by name — re-registration replaces
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    console.info("[morpho:hmr] graph module reloaded — cells rebuilt over durable roots");
  });
}
