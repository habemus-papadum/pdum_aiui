/**
 * Controls.tsx — the sliders.
 *
 * Each writes a durable signal in store.ts and nothing else; the cell graph
 * decides what has to be recomputed. Moving μ₁ redraws the sample (it changed
 * the generative model); moving `bins` does not (only the histogram depends on
 * it). That asymmetry is the dataflow graph doing its job, visible from here.
 */
import { For } from "solid-js";
import { clampParam, LIMITS, PARAMS, type ParamName, seed } from "../model/store";

const LABELS: Record<ParamName, string> = {
  weight: "weight",
  mu1: "μ₁",
  sigma1: "σ₁",
  mu2: "μ₂",
  sigma2: "σ₂",
  sampleCount: "samples",
  bins: "bins",
};

const ORDER: ParamName[] = ["weight", "mu1", "sigma1", "mu2", "sigma2", "sampleCount", "bins"];

export function Controls() {
  return (
    <section class="panel controls">
      <h2>model</h2>
      <For each={ORDER}>
        {(name) => (
          <label class="slider">
            <span class="slider-label">
              {LABELS[name]} <b>{PARAMS[name].get()}</b>
            </span>
            <input
              type="range"
              min={LIMITS[name].min}
              max={LIMITS[name].max}
              step={LIMITS[name].step}
              value={PARAMS[name].get()}
              onInput={(e) => PARAMS[name].set(clampParam(name, e.currentTarget.valueAsNumber))}
            />
          </label>
        )}
      </For>
      <button type="button" class="btn btn-outline" onClick={() => seed.set((s) => (s + 1) >>> 0)}>
        reseed
      </button>
    </section>
  );
}
