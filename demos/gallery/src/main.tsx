/**
 * main.tsx — the SPA shell: ONE document hosting the landing page and every
 * notebook behind client-side routing, so the aiui intent tool (its open turn,
 * its socket, its capture grant) survives switching pages — the whole point of
 * the rewrite (docs/proposals/spa-navigation-and-turn-continuity.md).
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
import { initTheme } from "@habemus-papadum/aiui-journal";
import { SiteNav } from "@habemus-papadum/aiui-viz/site";
import { createEffect, createSignal, Show, untrack } from "solid-js";
import { Landing } from "./site/Landing";
import { BRAND, LINKS, NAV_ITEMS } from "./site/nav";
import { type GalleryPage, loadPage } from "./site/pages";
import { interceptLocalLinks, LANDING, type Route, route } from "./site/router";

initTheme(); // dark-only journal — re-assert the head's data-theme="dark"
interceptLocalLinks();

interface View {
  route: Route;
  page: GalleryPage;
}

function Shell() {
  // The currently-loaded demo page (undefined before the first demo visit).
  // Kept even while on the landing, so returning to a demo re-mounts over its
  // surviving durables.
  const [view, setView] = createSignal<View | undefined>(undefined);
  let seq = 0;

  const show = async (r: Route): Promise<void> => {
    const my = ++seq;
    if (r === LANDING) {
      untrack(view)?.page.deactivate?.(); // park the demo's loops; keep durables
      document.title = "aiui notebooks";
      return;
    }
    const page = await loadPage(r); // cached after the first visit
    if (my !== seq) return; // superseded by a faster navigation (e.g. back home)
    const prev = untrack(view);
    if (prev?.route !== r) prev?.page.deactivate?.(); // park the old page's loops...
    page.activate?.(); // ...wake the new one's
    document.title = page.title;
    setView({ route: r, page });
  };

  // Track the route in the source, load/swap in the untracked handler.
  createEffect(route, (r) => {
    void show(r);
  });

  return (
    <div class="app-frame">
      <SiteNav brand={BRAND} items={NAV_ITEMS} active={route()} links={LINKS} />
      <main class="app-content">
        {/* Landing at the base route; otherwise the demo page. */}
        <Show when={route() !== LANDING} fallback={<Landing />}>
          {/* keyed: a route change DISPOSES the old page's component tree and
              mounts the new one over the surviving durables (the HMR discipline,
              reused). The brief first-load gap renders nothing on purpose —
              page chunks are small and local. */}
          <Show when={view()} keyed>
            {(v) => <v.page.App />}
          </Show>
        </Show>
      </main>
    </div>
  );
}

render(() => <Shell />, document.getElementById("root") as HTMLElement);
