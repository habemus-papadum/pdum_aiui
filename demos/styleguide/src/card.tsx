/**
 * card.tsx — the styleguide's landing card: the palette ladder as bars on the
 * plate, with the wordmark. Self-contained — no store, no graph.
 */
import { CHART, TOKENS } from "@habemus-papadum/aiui-design";
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import type { Component } from "solid-js";

const BARS = [
  TOKENS.surface,
  TOKENS.ghost,
  TOKENS.hairline,
  TOKENS.muted,
  TOKENS.inkMuted,
  TOKENS.ink,
  TOKENS.accent,
  CHART.blue,
  CHART.green,
  CHART.amber,
  TOKENS.ok,
  TOKENS.warn,
  TOKENS.alarm,
];

const Preview: Component = () => (
  <svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <title>the palette</title>
    <rect width="160" height="100" fill={TOKENS.plate} />
    {BARS.map((color, i) => (
      <rect x={14 + i * 10.2} y={22} width="8" height={46 - (i % 3) * 6} fill={color} />
    ))}
    <text
      x="80"
      y="88"
      text-anchor="middle"
      font-family="Fraunces Variable, Cormorant Garamond, serif"
      font-size="13"
      fill={TOKENS.plateInk}
      style={{ "font-variation-settings": '"SOFT" 100, "WONK" 1' }}
    >
      cotton paper · slate ink · one accent
    </text>
  </svg>
);

export const card: DemoCard = {
  blurb:
    "The design system on one page: palette, type roles, every aiui-viz component, the notebook chrome, and the tool chrome — the visual acceptance test.",
  Preview,
};
