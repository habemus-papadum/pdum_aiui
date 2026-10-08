/**
 * palette.ts — the seismos page's literal chart colors (design-choices §8:
 * figure/chart colors that can't be a CSS var live here). These are
 * *chart-on-panel* colors, validated with the dataviz procedure against the
 * design system's raised panel (`#e8e7e3` on cotton paper): every swatch sits
 * in the light lightness band, clears the chroma floor and 3:1 contrast, and
 * the three depth classes keep worst-adjacent CVD ΔE ≥ 22 (target ≥ 12).
 *
 * Depth class is an *ordered* category (shallow → deep), so the hues run warm →
 * cool; identity is never color-alone — the legend and the axis position carry
 * it too.
 */
import { TOKENS } from "@habemus-papadum/aiui-design";

export interface SeismicPalette {
  /** Single-series fill for the magnitude / depth / time histograms. */
  hist: string;
  /** Gutenberg–Richter fit line + Mc marker — a warm annotation ink vs the cool bars. */
  fit: string;
  /** Ordered depth classes (km): shallow <70, intermediate 70–300, deep >300. */
  shallow: string;
  intermediate: string;
  deep: string;
  /** d3 sequential scheme name for the epicenter density raster — the fallback
   * when no explicit ramp is given. */
  densityScheme: string;
  /** Explicit low→high ramp overriding `densityScheme`: it starts AT the panel
   * surface, so zero density dissolves into the panel instead of printing a
   * tinted plate (a stock scheme's pale floor does exactly that on paper). */
  densityRange?: string[];
  /**
   * Faint country-border overlay on the epicenter map — a *cosmetic underlay*
   * (like a graticule or the axis rule), not a data series, so it is exempt from
   * the categorical-CVD checks: it exists only to give the sparse density image
   * geographic context. Drawn on top of the (opaque) raster at `coastOpacity`,
   * tuned against the ramp's floor so the lines read as a whisper, never a grid.
   */
  coast: string;
  coastOpacity: number;
}

const PALETTE: SeismicPalette = {
  hist: "#2f6fce",
  fit: "#a86a12",
  shallow: "#cf6a30",
  intermediate: "#1f9068",
  deep: "#2f6fce",
  densityScheme: "YlOrRd",
  densityRange: [TOKENS.surfaceRaised, "#f3c46a", "#e8842f", "#c4301f", "#6b0a1f"],
  coast: "#5f6b78",
  coastOpacity: 0.42,
};

/** Accessor-shaped (the specs read it live), one light set. */
export const seismic = (): SeismicPalette => PALETTE;

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
