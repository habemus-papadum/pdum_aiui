/**
 * theme.ts — this app's palettes and Plot cosmetics, keyed by the library's
 * reactive color mode (`@habemus-papadum/aiui-viz/site`).
 *
 * The app follows `prefers-color-scheme` with no toggle (design-choices §8):
 * CSS design tokens on `:root` carry the dark-default / light-override colors
 * for everything the stylesheet can reach. This module supplies the colors that
 * must be *literal* values instead — chart series, Observable Plot cosmetics,
 * inline SVG strokes — driven off the `mode()` signal so those redraw on a
 * system theme change too. The mode machinery itself (durable matchMedia
 * signal) is library porcelain; only the palettes are this app's.
 */
import { type ColorMode, colorMode, isDark } from "@habemus-papadum/aiui-viz/site";

export { isDark };
/** The live system color mode (re-exported for existing call sites). */
export const mode = colorMode;

export type Mode = ColorMode;

/**
 * The canonical categorical chart palette, one validated set per mode (same
 * hues, mode-tuned lightness). Dark validated against the panel surface
 * #171b25; light against #ffffff — both pass the dataviz six checks (band,
 * chroma floor, adjacent CVD ΔE, 3:1 contrast). Fixed assignment: color follows
 * the series, never its rank. morphogen reads all three; aztec's frozen-fraction
 * line borrows `blue`.
 */
export interface ChartPalette {
  blue: string;
  green: string;
  purple: string;
}

const CHART: Record<Mode, ChartPalette> = {
  dark: { blue: "#4a86dd", green: "#2fa876", purple: "#9b6fdb" },
  light: { blue: "#2f6fce", green: "#1f9068", purple: "#7a52c8" },
};

export const chart = (): ChartPalette => CHART[mode()];

/**
 * Observable Plot cosmetics that need literal values per mode: `text` is the
 * axis/label/tick ink (Plot also derives its grid stroke from it), `rule` is a
 * baseline/reference-line gray, `strong` is an emphasized annotation ink.
 */
export interface PlotCosmetics {
  text: string;
  rule: string;
  strong: string;
}

const PLOT: Record<Mode, PlotCosmetics> = {
  dark: { text: "#9aa0aa", rule: "#3a4152", strong: "#c3c9d4" },
  light: { text: "#5a616e", rule: "#d3d7de", strong: "#3a414c" },
};

export const plot = (): PlotCosmetics => PLOT[mode()];

/** The `style` object for a Plot figure on a panel surface — transparent
 * background, mode-appropriate ink. Replaces the library's static PLOT_STYLE
 * (which only knew the dark surface). */
export const plotStyle = (): { background: string; color: string; fontSize: string } => ({
  background: "transparent",
  color: plot().text,
  fontSize: "11px",
});
