/**
 * theme.ts — morphogen's chart theming.
 *
 * The theme machinery (the chart palette, Plot cosmetics) lives in the
 * shared `@habemus-papadum/aiui-design` package; this
 * file is just the morphogen-facing name for the series colors, plus a
 * re-export so the ui/ components have one import site.
 *
 * `SERIES()` is a *function* (accessor-shaped): call it and read a channel —
 * `SERIES().blue`. One light palette today; the shape leaves room for another.
 */

export { chart as SERIES, plot, plotStyle } from "@habemus-papadum/aiui-design";
