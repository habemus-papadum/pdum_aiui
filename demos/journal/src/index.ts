/**
 * @habemus-papadum/aiui-journal — the dark-journal visual identity shared by
 * the notebook demos (demos/morphogen · aztec · seismos · circle) and the
 * gallery shell (demos/gallery). Internal to the pdum_aiui repo; never
 * published.
 *
 * Two halves, imported separately on purpose:
 *
 *  - `@habemus-papadum/aiui-journal` (this module) — the theme values that
 *    must be JS literals: the categorical chart palette, Observable Plot
 *    cosmetics, and the dark-mode constants.
 *  - `@habemus-papadum/aiui-journal/styles.css` — the design tokens (`:root`
 *    custom properties) and the notebook chrome (panels, sliders, buttons,
 *    tiles, cell/plot chrome, the site header and TOC rail). Each demo's
 *    standalone entry imports it BEFORE its own page css, and the gallery
 *    shell imports it once for every page.
 *
 * A demo's page-specific styles stay in the demo (`page.css`); this package
 * holds only what two or more surfaces share — the same seam as aiui-viz's
 * "styling is the consumer's" rule, applied one level up.
 */
export type { ChartPalette, ColorMode, Mode, PlotCosmetics } from "./theme";
export { chart, initTheme, isDark, mode, plot, plotStyle } from "./theme";
