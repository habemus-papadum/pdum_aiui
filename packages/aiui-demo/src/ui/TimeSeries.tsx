/**
 * TimeSeries.tsx — the observables over time: coverage and contrast, one line
 * each (two series → legend chips + direct color identity; palette validated
 * against the dark surface). Data is the durable history ring; the memo keys
 * off its version signal, so rows stream in at snapshot cadence and survive
 * hot edits.
 */

import { PlotFigure } from "@habemus-papadum/aiui-viz/plot";
import * as Plot from "@observablehq/plot";
import { createMemo } from "solid-js";
import { history } from "../model/store";
import { plotStyle, SERIES } from "./theme";

export function TimeSeries() {
  const rows = createMemo(() => {
    history.version();
    const list = history.rows;
    const t0 = list[0]?.t ?? Date.now();
    return list.map((s) => ({
      seconds: (s.t - t0) / 1000,
      coverage: s.coverage,
      contrast: s.contrast,
    }));
  });

  const options = createMemo<Plot.PlotOptions>(() => {
    const c = SERIES();
    return {
      height: 190,
      marginLeft: 44,
      style: plotStyle(),
      x: { label: "seconds", tickSize: 0 },
      y: { label: null, grid: true, domain: [0, Math.max(0.5, ...rows().map((r) => r.coverage))] },
      marks: [
        Plot.lineY(rows(), {
          x: "seconds",
          y: "coverage",
          stroke: c.blue,
          strokeWidth: 2,
          tip: true,
        }),
        Plot.lineY(rows(), {
          x: "seconds",
          y: "contrast",
          stroke: c.green,
          strokeWidth: 2,
          tip: true,
        }),
      ],
    };
  });

  return (
    <div class="panel">
      <div class="panel-head">
        <h2>observables</h2>
        <span class="legend">
          <i style={{ background: SERIES().blue }} /> coverage
          <i style={{ background: SERIES().green }} /> contrast
        </span>
      </div>
      <PlotFigure options={options} />
    </div>
  );
}
