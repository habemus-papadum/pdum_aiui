/**
 * slice.ts — the oscillator as a REUSABLE SLICE (playbook layer 2, both
 * sides), the worked example of the composability model:
 *
 *  - **The store factory** declares the control surface. It takes its
 *    {@link Scope} as an argument — explicitly, the way it takes any other
 *    dependency — so each instance's controls get distinct qualified identity
 *    (`left/freq`, `right/freq`) and distinct durable state. Without the
 *    scope, two instances from this ONE call site would silently share a
 *    single `freq` (same injected leaf name, same durable key — the failure
 *    scope exists to fix).
 *  - **The cells factory** builds the derived values over a store instance,
 *    inside whatever reactive owner the app's `hotCellGraph` provides. A
 *    slice never owns a `hotCellGraph` — that ritual is bound to the app
 *    module's `import.meta.hot`; the slice contributes cells to the app's one
 *    graph.
 *
 * Identity is still the compiler's: the leaf names (`freq`, `trace`), the
 * descriptions (these doc comments), and the locs are injected at the call
 * sites below — by the consuming app's toolchain for source-first workspace
 * use, or by this package's own build/test toolchain (vite.config.ts wires
 * `sourceLocatorVite` with a `locPrefix`, so locs read
 * "@habemus-papadum/aiui-oscillator/src/slice.ts:NN" anywhere they surface).
 */
import {
  action,
  type Cell,
  type ControlBox,
  cell,
  control,
  type RegisteredAction,
  type Scope,
  type SignalBox,
} from "@habemus-papadum/aiui-viz";
import { type OscillatorParams, oscillatorTrace } from "./oscillator";

/** One oscillator instance's control surface + internal state. */
export interface OscillatorStore {
  freq: ControlBox<number>;
  damping: ControlBox<number>;
  amp: ControlBox<number>;
  /** Internal (not a knob): the phase impulses accumulated from kicks. */
  phase: SignalBox<number>;
  kick: RegisteredAction;
}

/**
 * Declare one oscillator's control surface under `s`. Call once per instance
 * at module level (the store side of the durable/disposable split): controls
 * are durable, so instance state survives hot edits under its qualified key.
 */
export function oscillatorStore(s: Scope): OscillatorStore {
  /** Natural frequency, Hz. */
  const freq = control({ scope: s, value: 1, min: 0.1, max: 5, step: 0.1, unit: "Hz" });

  /** Damping ratio ζ — how fast the envelope dies (0 rings forever). */
  const damping = control({ scope: s, value: 0.15, min: 0, max: 1, step: 0.01 });

  /** Peak amplitude. */
  const amp = control({ scope: s, value: 1, min: 0.1, max: 2, step: 0.1 });

  // Internal state, not a knob — the surface is curated. Scoped durable key
  // ("left/phase"), so each instance keeps its own kicks across hot edits.
  const phase = s.durableSignal("phase", 0);

  /** Kick this oscillator: a quarter-turn phase impulse. */
  const kick = action({ scope: s, name: "kick", run: () => phase.set((p) => p + Math.PI / 2) });

  return { freq, damping, amp, phase, kick };
}

/** The slice's derived values over one store instance. */
export interface OscillatorCells {
  /** The sampled displacement trace for the current parameters. */
  trace: Cell<Float64Array>;
  /** The parameters the trace was computed from (for overlays/labels). */
  params: Cell<OscillatorParams>;
}

/** The trace's fixed sampling window (seconds shown · points). */
export const TRACE_SECONDS = 4;
export const TRACE_SAMPLES = 256;

/**
 * Build one instance's cells over its store. Call inside the app's
 * `hotCellGraph` build function — the cells register under qualified names
 * (`left/trace`) and their dependency edges point at the instance's own
 * controls.
 */
export function oscillatorCells(s: Scope, store: OscillatorStore): OscillatorCells {
  /** The oscillator's parameters, gathered (every knob plus the kicked phase). */
  const params = cell(
    () => ({
      freq: store.freq.get(),
      damping: store.damping.get(),
      amp: store.amp.get(),
      phase: store.phase.get(),
    }),
    (p) => p satisfies OscillatorParams,
    { scope: s },
  );

  /** The sampled displacement trace x(t) over the display window. */
  const trace = cell(
    () => ({ p: params() }),
    ({ p }) => oscillatorTrace(p, TRACE_SECONDS, TRACE_SAMPLES),
    {
      scope: s,
    },
  );

  return { trace, params };
}
