/**
 * card.tsx — the catalog's landing card: a specimen tray on the plate, one
 * row per shelf — a cell chain, a slider and an equation, a diagram, a
 * stroke, a chart — drawn once from the pure wave. Self-contained: no store,
 * no graph.
 */
import { CHART, TOKENS } from "@habemus-papadum/aiui-design";
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import type { Component } from "solid-js";
import { sampleWave } from "./model/wave";

const WAVE = sampleWave({ frequency: 2, damping: 0.8, shape: "sine" }, 60, 2)
  .map((p, i) => `${i ? "L" : "M"}${(92 + p.t * 28).toFixed(1)},${(76 - p.y * 10).toFixed(1)}`)
  .join("");

const Preview: Component = () => (
  <svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <title>the catalog — a specimen tray</title>
    <rect width="160" height="100" fill={TOKENS.plate} />
    {/* shelf lines */}
    {[22, 42, 62, 82].map((y) => (
      <line x1="12" x2="148" y1={y} y2={y} stroke={TOKENS.plateInk} stroke-opacity="0.18" />
    ))}
    {/* 1 · substrate: a cell chain */}
    <g stroke={TOKENS.plateInk} stroke-opacity="0.75" fill="none">
      <line x1="22" x2="46" y1="14" y2="14" />
      <line x1="54" x2="78" y1="14" y2="14" />
    </g>
    <circle cx="18" cy="14" r="4" fill={CHART.blue} />
    <circle cx="50" cy="14" r="4" fill={CHART.blue} />
    <circle cx="82" cy="14" r="4" fill={CHART.green} />
    {/* 2 · components: a slider and an equation */}
    <line x1="18" x2="62" y1="34" y2="34" stroke={TOKENS.plateInk} stroke-opacity="0.45" />
    <circle cx="44" cy="34" r="3.5" fill={TOKENS.accent} />
    <text
      x="76"
      y="38"
      font-family="KaTeX_Math, Cormorant Garamond, serif"
      font-style="italic"
      font-size="11"
      fill={TOKENS.plateInk}
    >
      y = e
      <tspan font-size="7" dy="-4">
        −ζt
      </tspan>
      <tspan dy="4"> sin 2πft</tspan>
    </text>
    {/* 3 · containers: a diagram */}
    <g fill="none" stroke={TOKENS.plateInk} stroke-opacity="0.75">
      <rect x="18" y="47" width="22" height="10" rx="1" />
      <rect x="54" y="47" width="22" height="10" rx="1" />
      <rect x="90" y="47" width="22" height="10" rx="1" />
      <line x1="40" x2="54" y1="52" y2="52" />
      <line x1="76" x2="90" y1="52" y2="52" />
    </g>
    <rect x="54" y="47" width="22" height="10" rx="1" fill={CHART.amber} fill-opacity="0.5" />
    {/* 4 · ink and a chart */}
    <path
      d="M18,78 C26,66 34,66 40,74 S52,82 60,70 S72,64 80,76"
      fill="none"
      stroke={TOKENS.plateInk}
      stroke-width="1.6"
      stroke-linecap="round"
    />
    <path d={WAVE} fill="none" stroke={CHART.blue} stroke-width="1.2" />
    <text
      x="80"
      y="95"
      text-anchor="middle"
      font-family="Libre Franklin, system-ui, sans-serif"
      font-size="6"
      letter-spacing="1"
      fill={TOKENS.plateInk}
      fill-opacity="0.7"
    >
      THE CATALOG · EVERY PIECE, LIVE
    </text>
  </svg>
);

export const card: DemoCard = {
  blurb:
    "The aiui-viz catalog as a page: every piece the package provides, with the piece itself shown live — a cell, a knob in an equation, a node in a diagram, a stroke of ink, a tool call — and the stamps an agent reads.",
  Preview,
};
