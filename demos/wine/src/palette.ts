/**
 * palette.ts — the wine page's literal chart colors (design-choices §8: figure
 * colors that can't be a CSS var live here). Chart-on-panel colors, validated
 * against the design system's raised panel (`#e8e7e3` on cotton paper) per
 * the dataviz procedure: the ten swatches sit in the light lightness band and
 * clear 3:1 against it.
 *
 * `categories` is the FIXED categorical assignment shared by the two places
 * variety is colored — the embedding view's `categoryColors` and the variety
 * bar's `colorRange` — so a cluster on the map and its bar wear the same hue.
 * Order is category order: the top-9 varieties by review count (assigned at
 * load, stable for a given dataset revision), then "other" as the deliberate
 * neutral — hues walk the wheel so adjacent categories stay separable, and
 * identity is never color-alone (the bar's y-axis names each variety).
 */
import { TOKENS } from "@habemus-papadum/aiui-design";

export interface WinePalette {
  /** Single-series fill for the points / price histograms. */
  hist: string;
  /** Ten category colors: top-9 varieties in rank order, then "other". */
  categories: string[];
  /** d3 sequential scheme for the world map's density raster — the fallback
   * when no explicit ramp is given. */
  densityScheme: string;
  /** Explicit low→high ramp overriding `densityScheme`. It starts AT the
   * panel surface, so zero density dissolves into the panel instead of
   * printing a tinted plate (a stock scheme's pale floor does exactly that
   * on paper); a consuming app under another design system passes its own. */
  densityRange?: string[];
  /** Border/graticule overlay ink — cosmetic underlay, tuned against the
   * ramp's floor (the seismos rationale). */
  coast: string;
  coastOpacity: number;
}

const PALETTE: WinePalette = {
  hist: "#2f6bcb",
  categories: [
    "#c22f45", // 1
    "#bf6410", // 2
    "#9a7f10", // 3
    "#4e8c25", // 4
    "#0f8a76", // 5
    "#2f6bcb", // 6
    "#6a55c9", // 7
    "#a23fae", // 8
    "#8a6440", // 9
    "#6d7480", // other
  ],
  densityScheme: "YlOrRd",
  densityRange: [TOKENS.surfaceRaised, "#f3c46a", "#e8842f", "#c4301f", "#6b0a1f"],
  coast: "#5f6b78",
  coastOpacity: 0.42,
};

/** Accessor-shaped (the specs and the embedding view read it live), one light set. */
export const wine = (): WinePalette => PALETTE;
