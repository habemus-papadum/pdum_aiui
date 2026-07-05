/**
 * GutenbergRichter.tsx — the derived Gutenberg–Richter view: NOT a vgplot island
 * but an Observable Plot figure driven by the cell graph. The cross-filter
 * selection flows brush → Mosaic stats-client → store.histo → grStats (pure
 * gr.ts) → here. So a brush on any coordinated view redraws this fit within a
 * frame. Rendered through aiui-viz's PlotFigure bridge (options in, SVG out).
 *
 * The plot: cumulative frequency–magnitude N(≥M) on a log y-axis (the classic GR
 * scatter), the maximum-likelihood fit line of slope −b drawn above Mc, and a
 * dashed rule at Mc marking where the catalog becomes complete — below it the
 * points bend down as small quakes go undetected, which is exactly why the fit
 * starts at Mc.
 */

import { PlotFigure } from "@habemus-papadum/aiui-viz/plot";
import * as Plot from "@observablehq/plot";
import { plotStyle } from "../../../site/theme";
import { seismosGraph } from "../graph";
import { seismic } from "../palette";
import { store } from "../store";

export function GutenbergRichter(props: { width?: number; height?: number }) {
  const options = (): Plot.PlotOptions => {
    const g = seismosGraph()?.grStats();
    const pal = seismic();
    const cos = plotStyle();
    const cum = g?.cumulative ?? [];
    const line = g?.fitLine ?? [];
    const mc = store.mc.get();
    const topN = cum.length ? cum[0].n : 10;
    const marks: Plot.Markish[] = [
      Plot.ruleX([mc], { stroke: pal.fit, strokeDasharray: "4,3", strokeOpacity: 0.7 }),
      Plot.dot(cum, { x: "mag", y: "n", fill: pal.hist, r: 2.6 }),
    ];
    if (line.length) {
      marks.push(Plot.line(line, { x: "mag", y: "n", stroke: pal.fit, strokeWidth: 2 }));
    }
    return {
      width: props.width ?? 380,
      height: props.height ?? 300,
      marginLeft: 52,
      marginBottom: 34,
      style: cos,
      x: { label: "magnitude M →", nice: true },
      y: {
        type: "log",
        label: "↑ N (≥ M)",
        grid: true,
        domain: [0.7, Math.max(10, topN * 1.6)],
      },
      marks,
    };
  };
  return <PlotFigure options={options} />;
}
