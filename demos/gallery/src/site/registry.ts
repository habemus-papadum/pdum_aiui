/**
 * registry.ts — the ONE import site of `virtual:demo-pages` (the discovery
 * plugin's output): the discovered demos, their slugs, and the default route.
 * Everything downstream — the router's slug set, the nav's tabs, the page
 * loaders — derives from this module, so "what's in the gallery" has exactly
 * one source: the `aiui.sitePage` markers in the sibling demo packages.
 */
import { demos } from "virtual:demo-pages";

export type { DemoPageEntry } from "virtual:demo-pages";

/** The discovered demos, in tab order (the plugin sorts by marker `order`). */
export const DEMOS = demos;

/** Route slugs, in tab order. */
export const SLUGS: readonly string[] = demos.map((d) => d.slug);

/** The lowest-order demo lives at the base URL and absorbs unknown paths. */
export const DEFAULT_ROUTE: string = demos[0]?.slug ?? "";
