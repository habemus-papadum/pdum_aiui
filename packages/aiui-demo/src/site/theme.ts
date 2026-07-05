/**
 * theme.ts — this app's palettes and Plot cosmetics, plus the mode signal.
 *
 * Theming policy is **per page**, anchored in each page's <head> no-flash
 * script (which stamps `<html data-theme>` before first paint) and finished
 * here at module load by reading that attribute back into the signal:
 *
 * - **morphogen + aztec** follow `prefers-color-scheme` (the style-guide
 *   default): their heads stamp the system mode, and `initSystemTheme()`
 *   (called from their entries) keeps signal + attribute live on OS changes.
 *   No toggle is rendered.
 * - **seismos** is the sanctioned one-off (see its NOTES.md): light by
 *   default — the epicenter map reads best on a light surface — with an
 *   explicit ThemeToggle persisted in localStorage. Only its head reads
 *   storage; only it calls `setMode`/`toggleMode`.
 *
 * Either way `mode()` is the single source of truth for the *literal* colors
 * below (chart series, Plot cosmetics, SVG strokes); CSS goes through the
 * `:root[data-theme]` tokens.
 */
import { createSignal } from "solid-js";

export type ColorMode = "light" | "dark";
export type Mode = ColorMode;

const STORAGE_KEY = "aiui-theme";

/** The head script already stamped the page's policy onto <html>. */
function initialMode(): Mode {
  if (typeof document !== "undefined" && document.documentElement.dataset.theme === "dark") {
    return "dark";
  }
  return "light";
}

const [mode, setModeSignal] = createSignal<Mode>(initialMode());

function reflect(m: Mode): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = m;
  }
}

/** The live color mode. Reading it in a chart's options memo re-renders that
 *  chart on a mode change (toggle or OS, per the page's policy). */
export { mode };
export const isDark = (): boolean => mode() === "dark";

/**
 * System-following pages (morphogen, aztec) call this once from their entry:
 * signal + attribute track `prefers-color-scheme` live. Entry modules run once
 * per page load, so the listener never stacks under HMR.
 */
export function initSystemTheme(): void {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = (dark: boolean) => {
    const m: Mode = dark ? "dark" : "light";
    setModeSignal(m);
    reflect(m);
  };
  apply(mql.matches);
  mql.addEventListener("change", (e) => apply(e.matches));
}

/** Set the mode explicitly and persist it (seismos's toggle only). */
export function setMode(m: Mode): void {
  setModeSignal(m);
  reflect(m);
  try {
    localStorage.setItem(STORAGE_KEY, m);
  } catch {
    /* ignore persistence failures */
  }
}

/** Flip between light and dark (the ThemeToggle handler). */
export function toggleMode(): void {
  setMode(mode() === "dark" ? "light" : "dark");
}

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
