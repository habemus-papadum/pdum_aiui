/**
 * The `/site` subpath — **porcelain** for notebook pages: the page-chrome
 * components and theming machinery the frontend-for-agents methodology's
 * "page anatomy" calls for (docs/guide/frontend-style-guide in the repo docs).
 *
 * - {@link SiteHeader} — the slim sticky top bar with notebook tabs.
 * - {@link TocRail} — the Observable-style "On this page" right rail.
 * - {@link TeX} — KaTeX math with the `data-tex` attribution stamp.
 * - {@link colorMode} — the reactive `prefers-color-scheme` signal apps key
 *   their per-mode palettes on.
 *
 * Kept off the core barrel so `katex` stays an optional peer — only `/site`
 * consumers pay for it. Styling is the consumer's throughout (`.site-*`,
 * `.toc-*`, `.math-*` class names) — the same CSS-ownership seam as CellView.
 */
export type { ColorMode } from "./color-mode";
export { colorMode } from "./color-mode";
export type { SiteHeaderProps, SiteTab } from "./site-header";
export { SiteHeader } from "./site-header";
export { TeX } from "./tex";
export { TocRail } from "./toc-rail";
