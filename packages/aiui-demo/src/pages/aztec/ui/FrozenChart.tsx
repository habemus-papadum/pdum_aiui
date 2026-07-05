/**
 * FrozenChart.tsx — the arctic circle, as a number over time. One series (the
 * frozen fraction as the diamond grows), so no legend — the title names it; a
 * dashed rule marks the n→∞ limit of 1 the curve is climbing toward. Data is
 * the recorded ring, so it fills in live as the fold runs and survives hot
 * edits. Observable Plot stays behind the shared PlotFigure seam.
 */
import { PlotFigure } from "@habemus-papadum/aiui-viz/plot";
import * as Plot from "@observablehq/plot";
import { createMemo } from "solid-js";
import { chart, plot, plotStyle } from "../../../site/theme";
import { aztecGraph } from "../graph";

export function FrozenChart() {
  const rows = () => aztecGraph()?.frozenSeries() ?? [];
  const options = createMemo<Plot.PlotOptions>(() => ({
    height: 190,
    marginLeft: 42,
    style: plotStyle(),
    x: { label: "order n", tickSize: 0 },
    y: { label: null, grid: true, domain: [0, 1.02] },
    marks: [
      Plot.ruleY([1], { stroke: plot().rule, strokeDasharray: "3,3" }),
      Plot.lineY(rows(), {
        x: "n",
        y: "frozenFraction",
        stroke: chart().blue,
        strokeWidth: 2,
        tip: true,
      }),
    ],
  }));

  return (
    <div class="panel">
      <div class="panel-head">
        <h2>frozen fraction vs order</h2>
        <span class="panel-sub">dominoes outside the arctic circle matching their corner → 1</span>
      </div>
      <PlotFigure options={options} />
    </div>
  );
}
