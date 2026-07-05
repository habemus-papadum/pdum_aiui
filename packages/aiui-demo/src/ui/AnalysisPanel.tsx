/**
 * AnalysisPanel.tsx — the heavy computation, made visible: capture / cancel
 * buttons, thoroughness + threshold knobs (moving either supersedes the
 * in-flight worker run — watch the progress stripe restart), the spot-size
 * histogram, and the correlogram with the dominant wavelength flagged.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import { PlotFigure } from "@habemus-papadum/aiui-viz/plot";
import * as Plot from "@observablehq/plot";
import { Show } from "solid-js";
import type { AnalysisResult } from "../analysis/analysis.worker";
import { morphoGraph } from "../model/graph";
import { autoAnalyze, quality, threshold } from "../model/store";
import { plot, plotStyle, SERIES } from "./theme";

function histogramOptions(a: AnalysisResult): Plot.PlotOptions {
  return {
    height: 150,
    style: plotStyle(),
    x: { label: "spot area (px²)", type: "band", tickSize: 0 },
    y: { label: null, grid: true },
    marks: [
      Plot.barY(a.histogram, {
        x: "area",
        y: "count",
        fill: SERIES().green,
        ry2: 4, // rounded data-end, flat baseline
        insetLeft: 1,
        insetRight: 1,
        tip: true,
      }),
    ],
  };
}

function correlogramOptions(a: AnalysisResult): Plot.PlotOptions {
  const purple = SERIES().purple;
  return {
    height: 150,
    style: plotStyle(),
    x: { label: "lag (px)" },
    y: { label: "autocorrelation", grid: true },
    marks: [
      Plot.ruleY([0], { stroke: plot().rule }),
      Plot.lineY(a.correlogram, {
        x: "lag",
        y: "correlation",
        stroke: purple,
        strokeWidth: 2,
        tip: true,
      }),
      ...(a.wavelength !== undefined
        ? [
            Plot.ruleX([a.wavelength], { stroke: purple, strokeDasharray: "3,3" }),
            Plot.text([{ x: a.wavelength, label: `λ ≈ ${a.wavelength}px` }], {
              x: "x",
              text: "label",
              frameAnchor: "top",
              dy: 8,
              dx: 4,
              textAnchor: "start",
              fill: plot().strong,
            }),
          ]
        : []),
    ],
  };
}

export function AnalysisPanel() {
  const g = () => morphoGraph();
  const analysis = () => g()?.analysis;

  const knob = (
    label: string,
    value: () => number,
    set: (v: number) => void,
    min: number,
    max: number,
    step: number,
  ) => (
    <label class="slider slider-compact">
      <span class="slider-label">
        {label} <b>{value()}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value()}
        onInput={(e) => set(e.currentTarget.valueAsNumber)}
      />
    </label>
  );

  return (
    <div class="panel">
      <div class="panel-head">
        <h2>structure analysis</h2>
        <span class="panel-sub">connected components + autocorrelation, in a worker</span>
      </div>
      <div class="analysis-controls">
        <button type="button" class="btn" onClick={() => g()?.captureAnalysis()}>
          capture &amp; analyze
        </button>
        <button
          type="button"
          class="btn btn-outline"
          disabled={!(analysis()?.loading() ?? false)}
          onClick={() => g()?.cancelAnalysis()}
        >
          cancel
        </button>
        <label class="check">
          <input
            type="checkbox"
            checked={autoAnalyze.get()}
            onInput={(e) => autoAnalyze.set(e.currentTarget.checked)}
          />
          auto
        </label>
        {knob("thoroughness", quality.get, quality.set, 1, 5, 1)}
        <label class="slider slider-compact">
          <span class="slider-label">
            threshold <b>{threshold.get().toFixed(2)}</b>
          </span>
          <input
            type="range"
            min={0.05}
            max={0.5}
            step={0.01}
            value={threshold.get()}
            onInput={(e) => threshold.set(e.currentTarget.valueAsNumber)}
          />
        </label>
      </div>
      <Show when={g()}>
        {(graph) => (
          <CellView of={graph().analysis} label="analyzing pattern structure">
            {(a) => (
              <div>
                <p class="analysis-summary">
                  {a().census.count} components · mean area{" "}
                  {Math.round(a().census.meanArea).toLocaleString()} px² · largest{" "}
                  {(100 * a().census.largestFraction).toFixed(1)}% of field ·{" "}
                  {a().phase === "complete"
                    ? `${Math.round(a().elapsedMs)} ms`
                    : "wavelength pass running…"}
                </p>
                <div class="chart-pair">
                  <PlotFigure options={() => histogramOptions(a())} />
                  <Show
                    when={a().correlogram.length > 0}
                    fallback={<div class="chart-waiting">correlogram streams in when ready…</div>}
                  >
                    <PlotFigure options={() => correlogramOptions(a())} />
                  </Show>
                </div>
              </div>
            )}
          </CellView>
        )}
      </Show>
    </div>
  );
}
