/**
 * plots.ts — the Observable Plot figures, as option builders. Training has
 * one figure set per lens: the run (loss and the four magnitudes over steps);
 * the clipping lens's ratio histogram with the band and the side fractions
 * over steps; the gradient lens's term × group heatmap, the alignment over
 * steps and the pairwise cosine matrix. Fourier keeps its partial sum. A
 * hovered term's series is drawn heavy; the rest step back.
 */
import { CHART, plot, plotStyle, TOKENS } from "@habemus-papadum/aiui-design";
import * as Plot from "@observablehq/plot";
import type { FourierSample } from "../model/fourier";
import { harmonicK } from "../model/fourier";
import { GROUPS, type GradientRow, type GradientView } from "../model/gradients";
import type { TrainRow } from "../model/graph";
import {
  type ClipRow,
  TERM_IDS,
  TERM_LABELS,
  type TermId,
  type TrainStep,
} from "../model/training";
import { HUE, HUE_CLIP, ramp } from "./hues";

export function trainingPlotOptions(rows: TrainRow[], hover: TermId | undefined): Plot.PlotOptions {
  const dim = hover !== undefined;
  return {
    height: 220,
    marginLeft: 44,
    style: plotStyle(),
    x: { label: "step", tickSize: 0 },
    y: { label: "magnitude", grid: true, domain: [0, 1.05] },
    marks: [
      Plot.ruleY([0], { stroke: plot().rule }),
      ...TERM_IDS.map((id) =>
        Plot.lineY(rows, {
          x: "step",
          y: id,
          stroke: HUE[id],
          strokeWidth: hover === id ? 2.5 : 1.25,
          strokeOpacity: dim && hover !== id ? 0.3 : 1,
        }),
      ),
    ],
  };
}

// ── the clipping lens ───────────────────────────────────────────────────────

/** The latest batch's ratios, binned, each sample colored by what the min took. */
const HIST = { lo: 0.4, hi: 1.8, bins: 28 } as const;
export function clipHistogramOptions(step: TrainStep | undefined, eps: number): Plot.PlotOptions {
  const w = (HIST.hi - HIST.lo) / HIST.bins;
  const counts = Array.from({ length: HIST.bins }, () => ({ unclipped: 0, clipped: 0 }));
  if (step !== undefined) {
    step.ratios.forEach((r, i) => {
      const a = step.advantages[i] ?? 0;
      const clipped = (a > 0 && r > 1 + eps) || (a < 0 && r < 1 - eps);
      const idx = Math.max(0, Math.min(HIST.bins - 1, Math.floor((r - HIST.lo) / w)));
      const bin = counts[idx] as { unclipped: number; clipped: number };
      if (clipped) bin.clipped++;
      else bin.unclipped++;
    });
  }
  // Stacked by hand: the unclipped samples of a bin, then the clipped on top.
  const rows = counts.flatMap((c, i) => {
    const x1 = HIST.lo + i * w;
    const x2 = x1 + w;
    return [
      { x1, x2, y1: 0, y2: c.unclipped, pick: "unclipped" },
      { x1, x2, y1: c.unclipped, y2: c.unclipped + c.clipped, pick: "clipped" },
    ];
  });
  return {
    height: 180,
    marginLeft: 40,
    style: plotStyle(),
    x: { label: "ratio r_t", domain: [HIST.lo, HIST.hi] },
    y: { label: "samples", grid: true },
    color: { domain: ["unclipped", "clipped"], range: [HUE_CLIP.unclipped, HUE_CLIP.clipped] },
    marks: [
      Plot.rect([{ x1: 1 - eps, x2: 1 + eps }], {
        x1: "x1",
        x2: "x2",
        fill: TOKENS.ghost,
        fillOpacity: 0.45,
      }),
      Plot.rect(rows, {
        x1: "x1",
        x2: "x2",
        y1: "y1",
        y2: "y2",
        fill: "pick",
        insetLeft: 0.5,
        insetRight: 0.5,
      }),
      Plot.ruleX([1], { stroke: plot().rule }),
      Plot.ruleX([1 - eps, 1 + eps], { stroke: TOKENS.inkMuted, strokeDasharray: "3 3" }),
      Plot.ruleY([0], { stroke: plot().rule }),
    ],
  };
}

/** The share of each step's batch below, inside and above the band, stacked; the clip fraction as a line. */
export function clipSeriesOptions(rows: ClipRow[]): Plot.PlotOptions {
  const tidy = rows.flatMap((r) => [
    { step: r.step, side: "below 1−ε", value: r.low },
    { step: r.step, side: "inside", value: r.inBand },
    { step: r.step, side: "above 1+ε", value: r.high },
  ]);
  return {
    height: 180,
    marginLeft: 40,
    style: plotStyle(),
    x: { label: "step", tickSize: 0 },
    y: { label: "share of batch", domain: [0, 1], grid: true },
    color: {
      domain: ["below 1−ε", "inside", "above 1+ε"],
      range: [HUE_CLIP.below, TOKENS.ghost, HUE_CLIP.above],
    },
    marks: [
      Plot.areaY(tidy, Plot.stackY({ x: "step", y: "value", fill: "side", fillOpacity: 0.75 })),
      Plot.lineY(rows, { x: "step", y: "clipped", stroke: HUE_CLIP.clipped, strokeWidth: 2 }),
      Plot.ruleY([0], { stroke: plot().rule }),
    ],
  };
}

// ── the gradient lens ───────────────────────────────────────────────────────

/** Each term's gradient norm spread over the parameter groups. */
export function gradientHeatmapOptions(
  view: GradientView | undefined,
  hover: TermId | undefined,
): Plot.PlotOptions {
  const tidy =
    view === undefined
      ? []
      : TERM_IDS.flatMap((id) =>
          view.terms[id].byGroup.map((w, g) => ({
            id,
            term: TERM_LABELS[id],
            group: GROUPS[g] as string,
            value: w * view.terms[id].norm,
          })),
        );
  return {
    height: 168,
    marginLeft: 112,
    marginBottom: 36,
    style: plotStyle(),
    x: { label: null, domain: [...GROUPS], tickSize: 0 },
    y: { label: null, domain: TERM_IDS.map((id) => TERM_LABELS[id]), tickSize: 0 },
    color: { type: "linear", range: [TOKENS.surfaceRaised, TOKENS.ink] },
    marks: [
      Plot.cell(tidy, {
        x: "group",
        y: "term",
        fill: "value",
        fillOpacity: (d: { id: TermId }) => (hover === undefined || d.id === hover ? 1 : 0.3),
        inset: 1.5,
      }),
    ],
  };
}

/** cos(g_k, g_total) over the run, per term: above zero the term helps the step, below it fights. */
export function alignmentPlotOptions(
  rows: GradientRow[],
  hover: TermId | undefined,
): Plot.PlotOptions {
  const dim = hover !== undefined;
  return {
    height: 180,
    marginLeft: 40,
    style: plotStyle(),
    x: { label: "step", tickSize: 0 },
    y: { label: "cos(g, g_total)", domain: [-1, 1], grid: true },
    marks: [
      Plot.ruleY([0], { stroke: plot().rule }),
      ...TERM_IDS.map((id) =>
        Plot.lineY(rows, {
          x: "step",
          y: (d: GradientRow) => d.align[id],
          stroke: HUE[id],
          strokeWidth: hover === id ? 2.5 : 1.25,
          strokeOpacity: dim && hover !== id ? 0.3 : 1,
        }),
      ),
    ],
  };
}

/** The pairwise cosines between the terms' gradients: red opposes, green agrees. */
export function cosineMatrixOptions(view: GradientView | undefined): Plot.PlotOptions {
  const tidy =
    view === undefined
      ? []
      : TERM_IDS.flatMap((a, i) =>
          TERM_IDS.map((b, j) => ({
            a: TERM_LABELS[a],
            b: TERM_LABELS[b],
            cos: view.cos[i]?.[j] ?? 0,
            diag: i === j,
          })),
        );
  const labels = TERM_IDS.map((id) => TERM_LABELS[id]);
  return {
    height: 180,
    marginLeft: 112,
    marginBottom: 48,
    style: plotStyle(),
    x: { label: null, domain: labels, tickSize: 0, tickRotate: -20 },
    y: { label: null, domain: labels, tickSize: 0 },
    marks: [
      Plot.cell(tidy, {
        x: "b",
        y: "a",
        fill: (d: { cos: number }) => (d.cos < 0 ? TOKENS.alarm : CHART.green),
        fillOpacity: (d: { cos: number; diag: boolean }) => (d.diag ? 0.08 : Math.abs(d.cos)),
        inset: 1.5,
      }),
      Plot.text(tidy, {
        x: "b",
        y: "a",
        text: (d: { cos: number; diag: boolean }) => (d.diag ? "" : d.cos.toFixed(2)),
        fill: TOKENS.ink,
        fontSize: 11,
      }),
    ],
  };
}

// ── fourier ─────────────────────────────────────────────────────────────────

export function fourierPlotOptions(
  samples: FourierSample[],
  n: number,
  hover: number | undefined,
  muted: ReadonlySet<number>,
): Plot.PlotOptions {
  const marks: Plot.Markish[] = [
    Plot.ruleY([0], { stroke: plot().rule }),
    Plot.lineY(samples, { x: "x", y: "square", stroke: plot().rule, strokeDasharray: "3 3" }),
  ];
  for (let j = 1; j <= n; j++) {
    const k = harmonicK(j);
    if (muted.has(k)) continue;
    const rows = samples.map((s) => ({ x: s.x, y: s.harmonics[j - 1] ?? 0 }));
    marks.push(
      Plot.lineY(rows, {
        x: "x",
        y: "y",
        stroke: hover === k ? TOKENS.accent : ramp(j, n),
        strokeWidth: hover === k ? 2.5 : 1,
        strokeOpacity: hover === undefined ? 0.45 : hover === k ? 1 : 0.15,
      }),
    );
  }
  marks.push(
    Plot.lineY(samples, {
      x: "x",
      y: "sum",
      stroke: TOKENS.ink,
      strokeWidth: 2,
      strokeOpacity: hover === undefined ? 1 : 0.35,
    }),
  );
  return {
    height: 240,
    marginLeft: 40,
    style: plotStyle(),
    x: {
      label: "x",
      domain: [-Math.PI, Math.PI],
      ticks: [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI],
      tickFormat: (v: number) => (v === 0 ? "0" : `${(v / Math.PI).toFixed(1).replace(".0", "")}π`),
    },
    y: { label: null, grid: true, domain: [-1.5, 1.5] },
    marks,
  };
}
