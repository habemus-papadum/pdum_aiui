/**
 * router.ts — the gallery's client-side router: a thin route mapping over the
 * shared `pathname()` signal (`@habemus-papadum/aiui-viz/site` path.ts, the
 * one source of truth for location — the SPA-navigation proposal's "router
 * choice is almost immaterial" made concrete; the intent client's navigation
 * watcher observes pushState/popstate identically either way).
 *
 * Why an SPA at all: one document means the intent tool — its open turn, its
 * websocket, its capture grant — survives switching notebooks. The old
 * multi-entry layout killed the turn on every header click
 * (the SPA-navigation-and-turn-continuity proposal, in git history, traces
 * the loss).
 *
 * Routes are DATA: the slugs come from the discovered demo packages
 * (site/registry.ts ← virtual:demo-pages), so a new demo's marker adds its
 * route with no edit here. The site HOME is the {@link LANDING} route (the card
 * grid), NOT a demo: it lives at the base URL, and every demo has its own
 * `/slug`. Unknown paths fall back to the landing.
 *
 * Routes are HEAD/TAIL: a route carries the full relative path
 * ("gear-talk/mesh"), the shell keys page identity on {@link headOf} (the
 * demo slug), and a page that routes internally (a slide deck) owns the tail
 * — reading it reactively off the same shared pathname signal, writing it
 * with replaceState through the same `navigateTo`. Without tail preservation
 * the link interceptor would SWALLOW a deck-internal anchor: preventDefault,
 * map "/talk/3" to route "talk", hit the same-route no-op — click eaten.
 *
 * Base-awareness: dev serves at "/", the published site at "/aiui/"
 * (vite.config.ts). `import.meta.env.BASE_URL` is compile-time truth for both;
 * routes are relative paths, hrefs are base-prefixed. Legacy `aztec.html` deep
 * links (the old multi-entry URLs, still published as real objects — see
 * publish.sh) resolve to the same routes.
 */
import { navigateTo, pathname } from "@habemus-papadum/aiui-viz/site";
import { createMemo } from "solid-js";
import { SLUGS } from "./registry";

export type Route = string;

/** The site's home — the landing card grid. Rendered at the base URL. */
export const LANDING: Route = "";

const BASE = import.meta.env.BASE_URL; // "/" in dev, "/aiui/" in the build

/** A route's href, base-prefixed ("/aztec" in dev, "/aiui/aztec" published);
 * the landing route is the base itself. */
export function hrefOf(route: Route): string {
  return route === LANDING ? BASE : `${BASE}${route}`;
}

/** A route's page identity: the demo slug is the path's first segment; the
 * tail (a deck's slide) belongs to the page, not the shell. */
export function headOf(route: Route): string {
  const slash = route.indexOf("/");
  return slash === -1 ? route : route.slice(0, slash);
}

/** pathname → route; the base path is the landing, a known slug is that demo
 * (tail segments preserved for the page's own router), and anything else
 * (including the legacy `.html` names for missing demos) falls back to the
 * landing. */
export function routeOf(pathname: string): Route {
  const rel = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.slice(1);
  const clean = rel.replace(/\/$/, "");
  const slash = clean.indexOf("/");
  const head = (slash === -1 ? clean : clean.slice(0, slash)).replace(/\.html$/, "");
  if (!SLUGS.includes(head)) return LANDING;
  return slash === -1 ? head : `${head}${clean.slice(slash)}`;
}

const routeMemo = createMemo(() => routeOf(pathname()));

/** The current route — the shell renders from this. Derived from the shared
 * pathname signal, so a page's own tail writes (replaceState through
 * `navigateTo`) and back/forward all flow through one source. */
export const route = routeMemo;

/** Navigate: pushState + signal; same-route is a no-op. Scrolls to top like a
 * real page change (hash links stay native — the browser scrolls those). */
export function navigate(to: Route): void {
  if (to === route()) return;
  navigateTo(hrefOf(to));
  window.scrollTo(0, 0);
}

/**
 * Delegated link interception — the strongest answer to the proposal's
 * gotcha #1 ("the link is the escape hatch"): EVERY same-origin, in-base
 * anchor click becomes a client-side navigation, so neither the sidebar nor a
 * prose link between notebooks (nor a landing card, nor a slide's cross-demo
 * link) can hard-navigate and kill an open intent turn. Hash-only links,
 * downloads, targets, external URLs, and modified clicks pass through
 * untouched.
 */
export function interceptLocalLinks(root: Document | HTMLElement = document): () => void {
  const onClick = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    const anchor = (e.target as Element | null)?.closest?.("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (anchor.target !== "" || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith(BASE)) return;
    // A same-path hash link is a section jump — the browser owns those.
    if (url.pathname === location.pathname && url.hash !== "") return;
    e.preventDefault();
    navigate(routeOf(url.pathname));
  };
  root.addEventListener("click", onClick as EventListener);
  return () => root.removeEventListener("click", onClick as EventListener);
}
