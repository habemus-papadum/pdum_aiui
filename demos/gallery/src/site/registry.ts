/**
 * registry.ts — the ONE import site of `virtual:demo-pages` (the discovery
 * plugin's output): the discovered demos and their slugs. Everything
 * downstream — the router's slug set, the sidebar items, the page loaders, the
 * landing cards — derives from this module, so "what's in the gallery" has
 * exactly one source: the `aiui.sitePage` markers in the sibling demo packages.
 *
 * The site's home is the LANDING page (site/router.ts's `LANDING`), not a demo:
 * every demo lives at its own `/slug`, and the base URL shows the card grid.
 */
import { demos } from "virtual:demo-pages";

export type { DemoPageEntry } from "virtual:demo-pages";

/** The discovered demos, in sidebar order (the plugin sorts by marker `order`). */
export const DEMOS = demos;

/** Route slugs, in order. */
export const SLUGS: readonly string[] = demos.map((d) => d.slug);
