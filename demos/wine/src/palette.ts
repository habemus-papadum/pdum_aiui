/**
 * palette.ts — the wine page's literal chart colors, one set per mode
 * (design-choices §8: figure colors that can't be a CSS var live here, keyed
 * off the reactive `mode()` so charts AND the embedding view re-tint on a
 * system theme flip). Chart-on-panel colors, tuned per mode, not flipped:
 * each mode's ten swatches sit in that mode's lightness band against its
 * panel surface (dark #171b25, light #ffffff) per the dataviz procedure.
 *
 * `categories` is the FIXED categorical assignment shared by the two places
 * variety is colored — the embedding view's `categoryColors` and the variety
 * bar's `colorRange` — so a cluster on the map and its bar wear the same hue.
 * Order is category order: the top-9 varieties by review count (assigned at
 * load, stable for a given dataset revision), then "other" as the deliberate
 * neutral — hues walk the wheel so adjacent categories stay separable, and
 * identity is never color-alone (the bar's y-axis names each variety).
 */
import { type Mode, mode } from "@habemus-papadum/aiui-journal";

export interface WinePalette {
  /** Single-series fill for the points / price histograms. */
  hist: string;
  /** Ten category colors: top-9 varieties in rank order, then "other". */
  categories: string[];
  /** d3 sequential scheme for the world map's density raster (per mode). */
  densityScheme: string;
  /** Explicit low→high ramp overriding `densityScheme`. A consuming app
   * whose panel surface no stock scheme floor matches (the pitch deck's
   * cotton paper) starts the ramp AT that surface color, so zero density
   * dissolves into the page instead of printing a tinted plate. */
  densityRange?: string[];
  /** Border/graticule overlay ink — cosmetic underlay, tuned per mode
   * against that mode's density-scheme floor (the seismos rationale). */
  coast: string;
  coastOpacity: number;
}

const PALETTE: Record<Mode, WinePalette> = {
  dark: {
    hist: "#4a86dd",
    categories: [
      "#e0576a", // 1 rose red
      "#e28a3a", // 2 orange
      "#cdb04a", // 3 gold
      "#7cb84e", // 4 green
      "#36b39e", // 5 teal
      "#4a86dd", // 6 blue
      "#8f7ce8", // 7 violet
      "#c96bd0", // 8 magenta
      "#b58a66", // 9 tan
      "#7c8494", // other — neutral, deliberately recessive
    ],
    densityScheme: "inferno",
    coast: "#c6cdd8",
    coastOpacity: 0.28,
  },
  light: {
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
    coast: "#5f6b78",
    coastOpacity: 0.42,
  },
};

export const wine = (): WinePalette => PALETTE[mode()];
