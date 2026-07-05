/**
 * theme.ts — morphogen's chart theming.
 *
 * The reactive theme machinery (the `mode()` signal, the per-mode chart palette,
 * Plot cosmetics) lives in the shared `src/site/theme.ts`; this file is just the
 * morphogen-facing name for the series colors, plus a re-export so the ui/
 * components have one import site.
 *
 * `SERIES()` is a *function* (per-mode): call it and read a channel —
 * `SERIES().blue`. Reading it inside a chart's options memo re-renders the chart
 * when the system theme flips.
 */

export { chart as SERIES, mode, plot, plotStyle } from "../site/theme";
