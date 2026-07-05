/**
 * palette.ts — the seismos page's literal chart colors, one validated set per
 * mode (design-choices §8: figure/chart colors that can't be a CSS var live
 * here, keyed off the reactive `mode()` signal so they redraw on a system theme
 * flip). These are *chart-on-panel* colors — tuned per mode, not flipped —
 * validated with the dataviz procedure against each mode's panel surface (dark
 * #171b25, light #ffffff): every swatch sits in its mode's lightness band,
 * clears the chroma floor and 3:1 contrast, and the three depth classes keep
 * worst-adjacent CVD ΔE ≥ 22 (target ≥ 12).
 *
 * Depth class is an *ordered* category (shallow → deep), so the hues run warm →
 * cool; identity is never color-alone — the legend and the axis position carry
 * it too.
 */
import { type Mode, mode } from "../../site/theme";

export interface SeismicPalette {
  /** Single-series fill for the magnitude / depth / time histograms. */
  hist: string;
  /** Gutenberg–Richter fit line + Mc marker — a warm annotation ink vs the cool bars. */
  fit: string;
  /** Ordered depth classes (km): shallow <70, intermediate 70–300, deep >300. */
  shallow: string;
  intermediate: string;
  deep: string;
  /** d3 sequential scheme name for the epicenter density raster (per mode). */
  densityScheme: string;
  /**
   * Faint country-border overlay on the epicenter map — a *cosmetic underlay*
   * (like a graticule or the axis rule), not a data series, so it is exempt from
   * the categorical-CVD checks: it exists only to give the sparse density image
   * geographic context. Drawn on top of the (opaque) raster at `coastOpacity`;
   * tuned per mode against that mode's density-scheme floor (inferno ≈ black,
   * YlOrRd ≈ pale) so the lines read as a whisper, never a grid.
   */
  coast: string;
  coastOpacity: number;
}

const PALETTE: Record<Mode, SeismicPalette> = {
  dark: {
    hist: "#4a86dd",
    fit: "#b8831c",
    shallow: "#d06a34",
    intermediate: "#2fa070",
    deep: "#4f86d8",
    densityScheme: "inferno",
    coast: "#c6cdd8",
    coastOpacity: 0.28,
  },
  light: {
    hist: "#2f6fce",
    fit: "#a86a12",
    shallow: "#cf6a30",
    intermediate: "#1f9068",
    deep: "#2f6fce",
    densityScheme: "YlOrRd",
    coast: "#5f6b78",
    coastOpacity: 0.42,
  },
};

export const seismic = (): SeismicPalette => PALETTE[mode()];

/** Depth-class legend rows in canonical order — the second, non-color channel. */
export const DEPTH_CLASSES: {
  key: "shallow" | "intermediate" | "deep";
  label: string;
  range: string;
}[] = [
  { key: "shallow", label: "shallow", range: "< 70 km" },
  { key: "intermediate", label: "intermediate", range: "70–300 km" },
  { key: "deep", label: "deep", range: "> 300 km" },
];
