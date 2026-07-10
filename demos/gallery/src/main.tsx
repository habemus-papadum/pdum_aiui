/**
 * main.tsx — the SPA shell: ONE document hosting all three notebooks behind
 * client-side routing, so the aiui intent tool (its open turn, its socket, its
 * capture grant) survives switching pages — the whole point of the rewrite
 * (docs/proposals/spa-navigation-and-turn-continuity.md).
 *
 * The shell owns what used to be duplicated per entry: the SiteHeader (tabs
 * driven by the route signal), the theme stamp, and `document.title`. Each
 * notebook remains a self-contained lazily-imported module (site/pages.ts) —
 * adding one is still a TABS entry plus a page module.
 *
 * Route changes are pause-not-destroy: the leaving page's component tree is
 * disposed (components are pure readers — the same disposability HMR relies
 * on) and its rAF loops are parked via `deactivate()`, while every durable —
 * the WebGL field, the workers, DuckDB, the history rings — survives for the
 * return visit. Link clicks anywhere in the document are intercepted into
 * `navigate()` (site/router.ts), so no anchor can hard-navigate and kill an
 * open turn.
 */
import { render } from "@solidjs/web";
import "./styles.css";
import { SiteHeader } from "@habemus-papadum/aiui-viz/site";
import { createEffect, createSignal, Show, untrack } from "solid-js";
import { BRAND, LINKS, TABS } from "./site/nav";
import { type GalleryPage, loadPage } from "./site/pages";
import { interceptLocalLinks, type Route, route } from "./site/router";
import { initSystemTheme } from "./site/theme";

initSystemTheme(); // the shell follows prefers-color-scheme (style-guide default)
interceptLocalLinks();

interface View {
  route: Route;
  page: GalleryPage;
}

function Shell() {
  const [view, setView] = createSignal<View | undefined>(undefined);
  let seq = 0;

  const show = async (r: Route): Promise<void> => {
    const my = ++seq;
    const page = await loadPage(r); // cached after the first visit
    if (my !== seq) return; // superseded by a faster navigation
    const prev = untrack(view);
    prev?.page.deactivate?.(); // park the old page's loops...
    page.activate?.(); // ...wake the new one's
    document.title = page.title;
    setView({ route: r, page });
  };

  // Track the route in the source, load/swap in the untracked handler.
  createEffect(route, (r) => {
    void show(r);
  });

  return (
    <>
      <SiteHeader brand={BRAND} tabs={TABS} active={route()} links={LINKS} />
      {/* keyed: a route change DISPOSES the old page's component tree and
          mounts the new one over the surviving durables (the HMR discipline,
          reused). The brief first-load gap renders nothing on purpose —
          page chunks are small and local. */}
      <Show when={view()} keyed>
        {(v) => <v.page.App />}
      </Show>
    </>
  );
}

render(() => <Shell />, document.getElementById("root") as HTMLElement);
