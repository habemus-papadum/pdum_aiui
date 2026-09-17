/**
 * The `/site` subpath — **porcelain** for notebook pages: the page-chrome
 * components and theming machinery the frontend-for-agents methodology's
 * "page anatomy" calls for (packages/aiui-viz/docs/frontend-style-guide in the repo docs).
 *
 * - {@link SiteNav} — the primary navigation: a left sidebar on desktop that
 *   collapses to a top bar + drawer on a phone.
 * - {@link TocRail} — the Observable-style "On this page" right rail.
 * - {@link TeX} — KaTeX math with the `data-tex` attribution stamp.
 * - {@link Lens} — levels of detail for any page: an inline trigger, a hover
 *   peek, a click-to-open detail panel in the page's own reactive graph
 *   (also on its own subpath, `./site/lens`, katex-free).
 * - {@link colorMode} — the reactive `prefers-color-scheme` signal apps key
 *   their per-mode palettes on.
 * - {@link pathname} / {@link navigateTo} — the one reactive source of truth
 *   for `location.pathname`, shared by a shell routing on the path's head and
 *   a page routing on its tail (a slide deck's slides).
 *
 * Kept off the core barrel so `katex` stays an optional peer — only `/site`
 * consumers pay for it. Styling is the consumer's throughout (`.site-*`,
 * `.toc-*`, `.math-*`, `.aiui-lens-*` class names) — the same CSS-ownership
 * seam as CellView.
 */

// Re-exported from core for discoverability: the page contract a shell mounts
// (SiteNav lists the pages; a SitePage is what a page shows; a DemoCard is its
// landing preview).
export type { DemoCard, SitePage } from "../site-page";
export type { ColorMode } from "./color-mode";
export { colorMode } from "./color-mode";
export { Lens, LensLayer } from "./lens";
export { navigateTo, pathname } from "./path";
export type { SiteNavItem, SiteNavProps } from "./site-nav";
export { SiteNav } from "./site-nav";
export { TeX } from "./tex";
export { TocRail } from "./toc-rail";
