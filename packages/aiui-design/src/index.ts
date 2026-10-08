/**
 * @habemus-papadum/aiui-design — the theme values that must be JavaScript
 * literals: what a canvas, an SVG stroke, or an Observable Plot option reads,
 * where `var()` cannot reach. The CSS half is the package's real surface:
 *
 *   import "@habemus-papadum/aiui-design/site.css";
 *
 * One palette, light only (DESIGN.md). The accessors stay CALLABLE
 * (`chart()`, `plot()`) because the demos' chart option memos were written
 * against accessor-shaped theme reads; a second palette could slot in behind
 * them without touching a chart.
 */

/** The ladder as hex literals — the twins of tokens.css's `color-mix()`
 * rungs, for code that paints (a legend chip on a canvas, an SVG stroke).
 * Pinned by the test next door: each is a real six-digit color and the
 * contrasts DESIGN.md claims hold against the paper. */
export const TOKENS = {
  surface: "#efeee9",
  surfaceRaised: "#e8e7e3",
  ink: "#3d434c",
  inkMuted: "#84878b",
  muted: "#96999b",
  hairline: "#babbba",
  ghost: "#d6d6d3",
  accent: "#4b3fc4",
  alarm: "#9b3b2a",
  ok: "#2a6e4e",
  warn: "#8a5f10",
  plate: "#0e1119",
  plateInk: "#e8e8ea",
} as const;

/** The font stacks, for the places that take a string (Plot's `style`,
 * canvas `ctx.font`). */
export const FONTS = {
  serif: '"Digits", "Cormorant Garamond", Georgia, serif',
  sans: '"Digits", "Libre Franklin", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
} as const;

/**
 * The categorical chart palette for series drawn ON THE PAPER (a Plot on a
 * raised panel) — validated against `surfaceRaised` by the test: each clears
 * 3:1, and the three are far apart for a color-vision-deficient reader.
 * Fixed assignment: a color follows its series, never its rank. There is
 * deliberately no purple — purple is the interaction accent, and a series
 * must never read as "this is clickable".
 */
export interface ChartPalette {
  blue: string;
  green: string;
  amber: string;
}

export const CHART: ChartPalette = {
  blue: "#2f6bcb",
  green: "#1e8a5e",
  amber: "#a8661a",
};

/** Accessor-shaped (see the module doc). */
export const chart = (): ChartPalette => CHART;

/**
 * Observable Plot cosmetics that need literal values: `text` is the axis,
 * label, and tick ink (Plot derives its grid stroke from it); `rule` is a
 * baseline or reference-line gray; `strong` is an emphasized annotation ink.
 */
export interface PlotCosmetics {
  text: string;
  rule: string;
  strong: string;
}

export const PLOT: PlotCosmetics = {
  text: "#6a6e73",
  rule: "#babbba",
  strong: "#3d434c",
};

export const plot = (): PlotCosmetics => PLOT;

/** The `style` object for a Plot figure on a raised panel: transparent
 * background, the cosmetics' text ink, the label face with Georgia digits. */
export const plotStyle = (): {
  background: string;
  color: string;
  fontSize: string;
  fontFamily: string;
} => ({
  background: "transparent",
  color: PLOT.text,
  fontSize: "12px",
  fontFamily: FONTS.sans,
});
