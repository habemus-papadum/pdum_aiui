/**
 * pages.ts — the shell's page cache: route → lazily-loaded page module.
 *
 * The loaders come from the discovered demo packages (site/registry.ts ←
 * virtual:demo-pages), one dynamic `import()` per demo — the code-splitting
 * seam, so Vite still builds one chunk per notebook and visiting morphogen
 * never downloads DuckDB. The page contract itself is aiui-viz's `SitePage`
 * (title, App, activate/deactivate — see its docs for the pause-not-destroy
 * lifecycle the shell drives).
 */
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { DEMOS } from "./registry";
import type { Route } from "./router";

/** The shell's page type — aiui-viz's SitePage, re-exported for the shell. */
export type GalleryPage = SitePage;

const loaded = new Map<Route, SitePage>();

/** Load (once) a route's page module; later visits reuse the module and its durables. */
export async function loadPage(route: Route): Promise<SitePage> {
  const hit = loaded.get(route);
  if (hit !== undefined) return hit;
  const demo = DEMOS.find((d) => d.slug === route);
  if (!demo) throw new Error(`no demo page for route "${route}"`);
  const { page } = await demo.load();
  loaded.set(route, page);
  return page;
}
