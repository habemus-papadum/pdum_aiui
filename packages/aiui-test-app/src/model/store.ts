/**
 * store.ts — the durable roots.
 *
 * Everything here survives a hot edit: slider positions are the user's
 * interaction state, the most precious thing in the HMR contract. The cell
 * graph (graph.ts) is disposable and rebuilds over these roots; the roots
 * themselves are created once and adopted by any re-evaluated module.
 *
 * Add new state HERE; add new dataflow over it in graph.ts.
 */
import { durable } from "@habemus-papadum/aiui-viz";
import { type Accessor, createSignal, type Setter } from "solid-js";

function signalBox<T>(
  key: string,
  // biome-ignore lint/complexity/noBannedTypes: mirrors createSignal's own Exclude<T, Function> overload
  initial: Exclude<T, Function>,
): { get: Accessor<T>; set: Setter<T> } {
  return durable(key, () => {
    const [get, set] = createSignal<T>(initial);
    return { get, set };
  });
}

// --- the generative model's parameters (what the samples are drawn from) -----

/** Mixing weight of the first component. */
export const weight = signalBox("param:weight", 0.35);
export const mu1 = signalBox("param:mu1", -1.6);
export const sigma1 = signalBox("param:sigma1", 0.7);
export const mu2 = signalBox("param:mu2", 1.9);
export const sigma2 = signalBox("param:sigma2", 1.1);

// --- how much data, and how it is drawn and binned ---------------------------

export const sampleCount = signalBox("param:sampleCount", 4000);
export const bins = signalBox("param:bins", 48);
/** Reseeding the PRNG redraws the sample without touching the model. */
export const seed = signalBox("param:seed", 20260709);

// --- bounds, shared by the sliders and the agent tools -----------------------

export const LIMITS = {
  weight: { min: 0.05, max: 0.95, step: 0.01 },
  mu1: { min: -6, max: 6, step: 0.1 },
  mu2: { min: -6, max: 6, step: 0.1 },
  sigma1: { min: 0.2, max: 3, step: 0.05 },
  sigma2: { min: 0.2, max: 3, step: 0.05 },
  sampleCount: { min: 500, max: 20000, step: 500 },
  bins: { min: 12, max: 120, step: 4 },
} as const;

/** Every tunable, as one object — the shape the agent tools read and write. */
export type ParamName = keyof typeof LIMITS;

export const PARAMS: Record<ParamName, { get: Accessor<number>; set: Setter<number> }> = {
  weight,
  mu1,
  mu2,
  sigma1,
  sigma2,
  sampleCount,
  bins,
};

/** Read every tunable at once. */
export function readParams(): Record<ParamName, number> {
  return {
    weight: weight.get(),
    mu1: mu1.get(),
    mu2: mu2.get(),
    sigma1: sigma1.get(),
    sigma2: sigma2.get(),
    sampleCount: sampleCount.get(),
    bins: bins.get(),
  };
}

/** Clamp to the declared bounds, and round the ones that must stay integers. */
export function clampParam(name: ParamName, value: number): number {
  const { min, max } = LIMITS[name];
  const clamped = Math.min(max, Math.max(min, value));
  return name === "sampleCount" || name === "bins" ? Math.round(clamped) : clamped;
}
