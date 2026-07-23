/**
 * router.ts — the gallery's client-side router: ~40 lines of pushState over a
 * flat route list, which is all a sidebar needs (the SPA-navigation proposal's
 * "router choice is almost immaterial" made concrete — every router bottoms
 * out in these primitives, and the intent client's navigation watcher observes
 * them all identically).
 *
 * Why an SPA at all: one document means the intent tool — its open turn, its
 * websocket, its capture grant — survives switching notebooks. The old
 * multi-entry layout killed the turn on every header click
 * (docs/proposals/spa-navigation-and-turn-continuity.md traces the loss).
 *
 * Routes are DATA: the slugs come from the discovered demo packages
 * (site/registry.ts ← virtual:demo-pages), so a new demo's marker adds its
 * route with no edit here. The site HOME is the {@link LANDING} route (the card
 * grid), NOT a demo: it lives at the base URL, and every demo has its own
 * `/slug`. Unknown paths fall back to the landing.
 *
 * Base-awareness: dev serves at "/", the published site at "/aiui/"
 * (vite.config.ts). `import.meta.env.BASE_URL` is compile-time truth for both;
 * routes are slugs, hrefs are base-prefixed. Legacy `aztec.html` deep links
 * (the old multi-entry URLs, still published as real objects — see publish.sh)
 * resolve to the same routes.
 */
import { createSignal } from "solid-js";
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

/** pathname → route; the base path is the landing, a known slug is that demo,
 * and anything else (including the legacy `.html` names for missing demos)
 * falls back to the landing. */
export function routeOf(pathname: string): Route {
  const rel = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.slice(1);
  const slug = rel.replace(/\/$/, "").replace(/\.html$/, "");
  return SLUGS.includes(slug) ? slug : LANDING;
}

const [route, setRoute] = createSignal<Route>(
  typeof location !== "undefined" ? routeOf(location.pathname) : LANDING,
);

/** The current route — the shell renders from this. */
export { route };

/** Navigate: pushState + signal; same-route is a no-op. Scrolls to top like a
 * real page change (hash links stay native — the browser scrolls those). */
export function navigate(to: Route): void {
  if (to === route()) return;
  history.pushState(null, "", hrefOf(to));
  setRoute(to);
  window.scrollTo(0, 0);
}

if (typeof window !== "undefined") {
  // Back/forward: the URL already changed; re-derive the route.
  window.addEventListener("popstate", () => setRoute(routeOf(location.pathname)));
}

/**
 * Delegated link interception — the strongest answer to the proposal's
 * gotcha #1 ("the link is the escape hatch"): EVERY same-origin, in-base
 * anchor click becomes a client-side navigation, so neither the sidebar nor a
 * prose link between notebooks (nor a landing card) can hard-navigate and kill
 * an open intent turn. Hash-only links, downloads, targets, external URLs, and
 * modified clicks pass through untouched.
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
