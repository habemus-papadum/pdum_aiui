/**
 * pages.ts — the shell's page registry: route → lazily-imported page module.
 *
 * Each notebook stays a self-contained module tree (its own store/graph/ui —
 * the property worth keeping from the old multi-entry layout); the dynamic
 * `import()` below is the code-splitting seam, so Vite still builds one chunk
 * per notebook and visiting morphogen never downloads DuckDB.
 *
 * The lifecycle contract is **pause-not-destroy**: durable resources (engines,
 * workers, canvases, accrued history) deliberately outlive the route — that is
 * the whole durable model — so leaving a page must PARK its continuous work
 * (the rAF loops), not tear anything down. Event-driven resources (workers
 * between jobs, DuckDB between queries, idle cells) cost nothing while
 * off-route and need no handling. Returning to a route re-mounts components
 * over the surviving durables, exactly like an HMR swap.
 */
import type { Component } from "solid-js";
import type { Route } from "./router";

export interface GalleryPage {
  /** `document.title` while this page is the route. */
  title: string;
  /** The page's root component (layer 3/4) — mounted per visit, disposable. */
  App: Component;
  /** Resume continuous work (rAF loops). Called before mount, idempotent. */
  activate?(): void;
  /** Park continuous work. Called when the route leaves, idempotent. */
  deactivate?(): void;
}

const LOADERS: Record<Route, () => Promise<{ page: GalleryPage }>> = {
  morphogen: () => import("@habemus-papadum/demo-morphogen/page"),
  aztec: () => import("@habemus-papadum/demo-aztec/page"),
  seismos: () => import("../pages/seismos/page"),
  circle: () => import("../pages/circle/page"),
};

const loaded = new Map<Route, GalleryPage>();

/** Load (once) a route's page module; later visits reuse the module and its durables. */
export async function loadPage(route: Route): Promise<GalleryPage> {
  const hit = loaded.get(route);
  if (hit !== undefined) return hit;
  const { page } = await LOADERS[route]();
  loaded.set(route, page);
  return page;
}
