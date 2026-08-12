/**
 * theme.ts — the journal's palettes and Plot cosmetics, shared by every
 * notebook demo and the gallery shell (the CSS half of the identity is
 * ./styles.css — design tokens + notebook chrome).
 *
 * The journal **follows the system color scheme** (design-choices §8, restored
 * 2026-08-12 — it was dark-only from 2026-07-19 until then): no toggle, no
 * `data-theme` stamp, one source of truth. CSS gets there through the `:root`
 * tokens and one `prefers-color-scheme` media block (styles.css); the LITERAL
 * colors below (chart series, Plot cosmetics, SVG strokes) key on `mode()`,
 * which delegates to aiui-viz's reactive `colorMode()` — so a chart whose
 * options memo reads `chart()`/`plot()` re-renders on a live theme change.
 * Simulation canvases and boards are deliberately exempt: they are
 * self-contained dark figures (`--figure-bg`, cross-mode), like journal
 * plates, so nothing imperative ever needs to repaint on a theme flip.
 */
import { colorMode } from "@habemus-papadum/aiui-viz/site/color-mode";

export type ColorMode = "light" | "dark";
export type Mode = ColorMode;

/** The live color mode — reactive: reading it in a chart's options memo
 * re-renders that chart on a system theme change. */
export const mode = (): Mode => colorMode();
export const isDark = (): boolean => mode() === "dark";

/**
 * The canonical categorical chart palette, one per mode, each validated
 * against its own panel surface with the dataviz six checks (band, chroma
 * floor, adjacent CVD ΔE, 3:1 contrast) — never an automatic flip. Fixed
 * assignment: color follows the series, never its rank. morphogen reads all
 * three; aztec's frozen-fraction line borrows `blue`.
 */
export interface ChartPalette {
  blue: string;
  green: string;
  purple: string;
}

/** Both validated palettes, exported for tests and re-validation runs. */
export const CHART_PALETTES: Record<Mode, ChartPalette> = {
  dark: {
    blue: "#4a86dd",
    green: "#2fa876",
    purple: "#9b6fdb",
  },
  light: {
    blue: "#2f6bcb",
    green: "#1e8a5e",
    purple: "#7c4fc4",
  },
};

export const chart = (): ChartPalette => CHART_PALETTES[mode()];

/**
 * Observable Plot cosmetics that need literal values: `text` is the
 * axis/label/tick ink (Plot also derives its grid stroke from it), `rule` is a
 * baseline/reference-line gray, `strong` is an emphasized annotation ink.
 */
export interface PlotCosmetics {
  text: string;
  rule: string;
  strong: string;
}

/** Both cosmetic sets, exported for tests and re-validation runs. */
export const PLOT_COSMETICS: Record<Mode, PlotCosmetics> = {
  dark: {
    text: "#9aa0aa",
    rule: "#3a4152",
    strong: "#c3c9d4",
  },
  light: {
    text: "#5a6472",
    rule: "#c9d0da",
    strong: "#333c4b",
  },
};

export const plot = (): PlotCosmetics => PLOT_COSMETICS[mode()];

/** The `style` object for a Plot figure on a panel surface — transparent
 * background, that mode's panel ink. */
export const plotStyle = (): { background: string; color: string; fontSize: string } => ({
  background: "transparent",
  color: plot().text,
  fontSize: "11px",
});
