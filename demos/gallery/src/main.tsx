/**
 * main.tsx — the SPA shell: ONE document hosting the landing page and every
 * notebook behind client-side routing, so the aiui intent tool (its open turn,
 * its socket, its capture grant) survives switching pages — the whole point of
 * the rewrite (the SPA-navigation-and-turn-continuity proposal, git history).
 *
 * The layout is a left SIDEBAR (`<SiteNav>`, which collapses to a top bar +
 * drawer on a phone) plus the content area. The site HOME is the LANDING page
 * (a card per demo, each with a live preview — site/Landing.tsx); every demo
 * lives at its own `/slug`. Each notebook is a self-contained DEMO PACKAGE
 * discovered through its `aiui.sitePage` marker (demo-discovery.ts →
 * virtual:demo-pages) and lazily imported — adding one is giving a demo the
 * marker; nothing here changes.
 *
 * Route changes are pause-not-destroy: the leaving page's component tree is
 * disposed (components are pure readers — the same disposability HMR relies
 * on) and its rAF loops are parked via `deactivate()`, while every durable —
 * the WebGL field, the workers, DuckDB, the history rings — survives for the
 * return visit. Leaving a demo for the landing parks it the same way. Link
 * clicks anywhere in the document are intercepted into `navigate()`
 * (site/router.ts), so no anchor can hard-navigate and kill an open turn.
 */
import { render } from "@solidjs/web";
import "@habemus-papadum/aiui-journal/styles.css";
import { PageBoundary, setSitePageActive } from "@habemus-papadum/aiui-viz";
import { SiteNav } from "@habemus-papadum/aiui-viz/site";
import { createEffect, createSignal, Show, untrack } from "solid-js";
import { Landing } from "./site/Landing";
import { BRAND, LINKS, NAV_ITEMS } from "./site/nav";
import { type GalleryPage, loadPage } from "./site/pages";
import { headOf, interceptLocalLinks, LANDING, type Route, route } from "./site/router";

interceptLocalLinks();

interface View {
  /** The mounted page's identity: the route's HEAD (demo slug) — a tail
   * change (a deck moving between slides) must never remount the page. */
  slug: Route;
  page: GalleryPage;
}

function Shell() {
  // The currently-loaded demo page (undefined before the first demo visit).
  // Kept even while on the landing, so returning to a demo re-mounts over its
  // surviving durables.
  const [view, setView] = createSignal<View | undefined>(undefined);
  let seq = 0;

  // The route we last handled — distinguishes "tail-only change on the live
  // page" (a deck's slide URL: ignore, the page owns its tail) from
  // "returning from the landing to the same demo" (must re-activate).
  let shown: Route = LANDING;

  const show = async (r: Route): Promise<void> => {
    const from = shown;
    shown = r;
    if (r === LANDING) {
      ++seq; // cancel any in-flight mount
      const parked = untrack(view)?.page;
      if (parked) setSitePageActive(parked, false); // park loops + tools bit; keep durables
      document.title = "aiui notebooks";
      return;
    }
    const slug = headOf(r);
    // A tail-only change (written with replaceState by the page itself) is
    // the page's business — the mount must not churn, and an in-flight first
    // mount of this same page must keep going (no seq bump here).
    if (from !== LANDING && headOf(from) === slug) return;
    const my = ++seq;
    const page = await loadPage(slug); // cached after the first visit
    if (my !== seq) return; // superseded by a faster navigation (e.g. back home)
    const prev = untrack(view);
    // setSitePageActive drives BOTH lifecycles — the rAF park/resume and the
    // page-tools activity bit (page.toolsNs) — so route-following consumers
    // (the oracle) see only the notebook in view (the page-tools proposal,
    // git history).
    if (prev !== undefined && prev.slug !== slug) setSitePageActive(prev.page, false);
    setSitePageActive(page, true);
    document.title = page.title;
    if (prev?.slug !== slug) setView({ slug, page });
  };

  // Track the route in the source, load/swap in the untracked handler.
  createEffect(route, (r) => {
    void show(r);
  });

  return (
    <div class="app-frame">
      <SiteNav brand={BRAND} items={NAV_ITEMS} active={headOf(route())} links={LINKS} />
      <main class="app-content">
        {/* Landing at the base route; otherwise the demo page. */}
        <Show when={route() !== LANDING} fallback={<Landing />}>
          {/* keyed: a route change DISPOSES the old page's component tree and
              mounts the new one over the surviving durables (the HMR discipline,
              reused). The brief first-load gap renders nothing on purpose —
              page chunks are small and local. PageBoundary is the containment
              seam: one page's uncaught effect throw would otherwise halt the
              WHOLE shared document's reactive system (Solid 2.0-beta.32). */}
          <Show when={view()} keyed>
            {(v) => (
              <PageBoundary name={v.page.title}>
                <v.page.App />
              </PageBoundary>
            )}
          </Show>
        </Show>
      </main>
    </div>
  );
}

render(() => <Shell />, document.getElementById("root") as HTMLElement);
