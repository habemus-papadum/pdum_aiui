/**
 * theme.ts — the dark journal's palettes and Plot cosmetics, shared by every
 * notebook demo and the gallery shell (the CSS half of the identity is
 * ./styles.css — design tokens + notebook chrome).
 *
 * The journal is **dark only** (owner, 2026-07-19): there is no light mode and
 * no toggle. `mode()` is a constant `"dark"`, kept as a function so the
 * chart/Plot option memos that read it don't change shape. The host page's
 * head stamps `data-theme="dark"` before first paint; `initTheme()` re-asserts
 * it defensively at module load. `mode()` remains the single source of truth
 * for the *literal* colors below (chart series, Plot cosmetics, SVG strokes);
 * CSS goes through the `:root` tokens (styles.css).
 */

export type ColorMode = "light" | "dark";
export type Mode = ColorMode;

/** The color mode. Constant `"dark"` — the journal has one surface. */
export const mode = (): Mode => "dark";
export const isDark = (): boolean => true;

/** Re-assert the dark attribute at module load (the head already stamped it
 * pre-paint; this covers any environment where the head script didn't run). */
export function initTheme(): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = "dark";
  }
}

/**
 * The canonical categorical chart palette, validated against the dark panel
 * surface #171b25 (the dataviz six checks: band, chroma floor, adjacent CVD ΔE,
 * 3:1 contrast). Fixed assignment: color follows the series, never its rank.
 * morphogen reads all three; aztec's frozen-fraction line borrows `blue`.
 */
export interface ChartPalette {
  blue: string;
  green: string;
  purple: string;
}

export const chart = (): ChartPalette => ({
  blue: "#4a86dd",
  green: "#2fa876",
  purple: "#9b6fdb",
});

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

export const plot = (): PlotCosmetics => ({
  text: "#9aa0aa",
  rule: "#3a4152",
  strong: "#c3c9d4",
});

/** The `style` object for a Plot figure on a panel surface — transparent
 * background, dark-surface ink. */
export const plotStyle = (): { background: string; color: string; fontSize: string } => ({
  background: "transparent",
  color: plot().text,
  fontSize: "11px",
});
