/**
 * store.ts — the durable roots of the app (the state side of playbook layer 2).
 *
 * Everything in this module survives a hot edit: the parameter signals (the
 * user's slider positions are interaction state — the most precious thing in
 * the HMR contract), the canvas + WebGL engine (minutes of accrued
 * morphogenesis), the running render loop, the analysis worker, and the
 * observable history ring. All of it lives in the durable registry
 * (`durableSignal`/`durable`, from @habemus-papadum/aiui-viz), created once and
 * *adopted* by any re-evaluated module.
 *
 * The companion rule: this file is the guarded, rarely-edited wiring; the
 * cell graph (graph.ts) and the components (ui/) are the disposable logic
 * edited constantly. Splitting the two along module lines is what gives HMR
 * an easy job — see archive/agentic_ui_workflow/hmr_for_agentic_coding.md.
 */
import { control, durable, durableSignal } from "@habemus-papadum/aiui-viz";
import { type Accessor, createSignal } from "solid-js";
import { GrayScottEngine } from "../sim/gray-scott";
import { type SimLoop, type Snapshot, startLoop } from "../sim/loop";
import { DISPLAY_FRAG, ENCODE_FRAG, QUAD_VERT, STEP_FRAG } from "../sim/shaders";

export const SIM_SIZE = 256;
export const HISTORY_LIMIT = 600; // ~2.5 min at 4 Hz

// --- the control surface (described, constrained, agent-settable) ------------
//
// Names, definition sites, and the descriptions below are compiler-injected
// (the doc comment IS the registry description). Bounds live here once — the
// ControlSlider widgets, the keyboard, and the agent's `set` tool all validate
// through them.

/** Gray-Scott feed rate F. */
export const paramF = control({ value: 0.0545, min: 0.005, max: 0.09, step: 0.0005 });

/** Gray-Scott kill rate k. */
export const paramK = control({ value: 0.062, min: 0.03, max: 0.075, step: 0.0005 });

/** Simulation steps per frame; 0 pauses. */
export const speed = control({ value: 12, min: 0, max: 48, step: 1 });

/** Brush radius for painting chemical V, in uv units. */
export const brushRadius = control({ value: 0.04, min: 0.01, max: 0.12, step: 0.005 });

/** Analysis cutoff: V above this counts as pattern. */
export const threshold = control({ value: 0.1, min: 0.05, max: 0.5, step: 0.01 });

/** Analysis thoroughness (spot-metric sampling density). */
export const quality = control({ value: 3, min: 1, max: 5, step: 1 });

/** Re-run the structure analysis on a cadence while the sim runs. */
export const autoAnalyze = control({ value: true });

/** Make the next catalog download fail (demonstrates the error/retry chrome). */
export const failNextFetch = control({ value: false });

// Diffusion rates are fixed in this demo (they rescale the same regimes).
export const DIFFUSION = { Du: 1.0, Dv: 0.5 };

// --- the live snapshot stream (loop → reactive bridge) ----------------------

export const snapshot = durableSignal<Snapshot | undefined>("snapshot", undefined);

// --- observable history (durable ring + version signal) ---------------------

export interface HistoryRing {
  rows: Snapshot[];
  version: Accessor<number>;
  push(snap: Snapshot): void;
  clear(): void;
}

export const history: HistoryRing = durable("history", () => {
  const [version, setVersion] = createSignal(0);
  const rows: Snapshot[] = [];
  return {
    rows,
    version,
    push(snap: Snapshot) {
      rows.push(snap);
      if (rows.length > HISTORY_LIMIT) rows.splice(0, rows.length - HISTORY_LIMIT);
      setVersion((v) => v + 1);
    },
    clear() {
      rows.length = 0;
      setVersion((v) => v + 1);
    },
  };
});

// --- sim engine + loop (durable; canvas is a durable DOM island) ------------

/**
 * The canvas is created OUTSIDE any component and adopted by whichever
 * SimCanvas render is current — so a component hot-swap re-parents the same
 * canvas and the WebGL context (and the pattern in its textures) survives.
 */
export const simCanvas: HTMLCanvasElement = durable("canvas", () => {
  const canvas = document.createElement("canvas");
  canvas.width = SIM_SIZE * 2; // presented with CSS upscaling on top
  canvas.height = SIM_SIZE * 2;
  canvas.className = "sim-canvas";
  return canvas;
});

export interface SimHandle {
  engine: GrayScottEngine;
  loop: SimLoop;
}

export const sim: SimHandle = durable("sim", () => {
  const engine = new GrayScottEngine(simCanvas, SIM_SIZE, {
    vertex: QUAD_VERT,
    step: STEP_FRAG,
    display: DISPLAY_FRAG,
    encode: ENCODE_FRAG,
  });
  const loop = startLoop({
    engine,
    onSnapshot: (snap) => {
      snapshot.set(snap);
      history.push(snap);
    },
  });
  return { engine, loop };
});

// --- analysis worker (durable resource) --------------------------------------

export const analysisWorker: Worker = durable(
  "analysisWorker",
  () => new Worker(new URL("../analysis/analysis.worker.ts", import.meta.url), { type: "module" }),
);

// --- HMR: a shader edit is disposable logic; the field is durable state ------
//
// This module is the *direct importer* of sim/shaders.ts, which is what lets
// it accept that dep (Vite only routes an update to acceptors that import the
// changed module directly). The engine recompiles its programs in place and
// the accrued pattern — minutes of morphogenesis — survives the edit.
if (import.meta.hot) {
  import.meta.hot.accept("../sim/shaders", (mod) => {
    if (!mod) return;
    try {
      sim.engine.recompile({
        vertex: mod.QUAD_VERT,
        step: mod.STEP_FRAG,
        display: mod.DISPLAY_FRAG,
        encode: mod.ENCODE_FRAG,
      });
      console.info("[morpho:hmr] shaders recompiled in place — field preserved");
    } catch (err) {
      // A bad GLSL edit fails loud and half-swaps nothing (recompile only
      // replaces programs when all three compile).
      console.error("[morpho:hmr] shader recompile failed:", err);
    }
  });
}
