/**
 * AnalysisPanel.tsx — the heavy computation, made visible: capture / cancel
 * buttons, thoroughness + threshold knobs (moving either supersedes the
 * in-flight worker run — watch the progress stripe restart), the spot-size
 * histogram, and the correlogram with the dominant wavelength flagged.
 */

import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
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
  const analysis = () => g().analysis;

  return (
    <div class="panel">
      <div class="panel-head">
        <h2>structure analysis</h2>
        <span class="panel-sub">connected components + autocorrelation, in a worker</span>
      </div>
      <div class="analysis-controls">
        <button type="button" class="btn" onClick={() => g().captureAnalysis()}>
          capture &amp; analyze
        </button>
        <button
          type="button"
          class="btn btn-outline"
          disabled={!analysis().loading()}
          onClick={() => g().cancelAnalysis()}
        >
          cancel
        </button>
        <ControlToggle of={autoAnalyze} label="auto" />
        <ControlSlider of={quality} label="thoroughness" class="slider-compact" />
        <ControlSlider of={threshold} class="slider-compact" format={(v) => v.toFixed(2)} />
      </div>
      <CellView of={g().analysis} label="analyzing pattern structure">
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
    </div>
  );
}
