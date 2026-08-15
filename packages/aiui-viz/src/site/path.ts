/**
 * path.ts — one reactive source of truth for `location.pathname`, once per
 * page.
 *
 * A multi-surface document routes at more than one granularity: a site shell
 * swaps pages on the path's HEAD while a page (a slide deck, an app with
 * internal views) routes on the TAIL — two writers of the same
 * `location.pathname`. Events won't compose them; a shared signal does. Both
 * derive their state from {@link pathname} and both write through
 * {@link navigateTo}, so neither needs to know the other exists and neither
 * can miss the other's writes (the history API itself fires no event for
 * pushState — only for popstate — which is exactly the gap this closes).
 *
 * Deliberately base-free and env-free: a package's dist build can never read
 * its consumer's `import.meta.env` (build-time substitution — the packaging
 * rule), so base prefixes belong to consumers. The gallery keeps its
 * `BASE_URL` handling in its own router; a deck binds under the route it was
 * mounted at. This module owns only the raw pathname and the write path.
 *
 * The signal + its popstate listener live in the durable registry (the
 * color-mode precedent): route modules are imported widely, so an HMR
 * re-evaluation must not stack a second listener or drop the current value.
 */
import { type Accessor, createSignal } from "solid-js";
import { durable } from "../durable";

/** Non-browser realms (node test runs) get a static "/" instead of a throw —
 * the durable registry itself lives on `window`, so the guard must come
 * BEFORE the durable call, not just around `location`. */
function makePathBox(): { get: Accessor<string>; set?: (p: string) => void } {
  if (typeof window === "undefined" || typeof window.location === "undefined") {
    const [get] = createSignal("/");
    return { get };
  }
  return durable("aiui:pathname", () => {
    const [get, set] = createSignal(window.location.pathname);
    window.addEventListener("popstate", () => set(window.location.pathname));
    return { get, set };
  });
}

const pathBox = makePathBox();

/** The live `location.pathname`. Tracks popstate and every {@link navigateTo};
 * derive routes from it at whatever granularity the consumer owns. */
export const pathname: Accessor<string> = pathBox.get;

/**
 * Navigate: write the history entry AND the signal in one place. `replace`
 * swaps the current entry (a deck scrolling between slides must not spam
 * history); the default pushes (a page change earns a Back stop). Same-path
 * is a no-op. Search/hash are deliberately out of scope — hash links stay the
 * browser's (the router-gotcha rule), and a consumer that needs query state
 * owns it explicitly.
 */
export function navigateTo(path: string, options?: { replace?: boolean }): void {
  if (typeof window === "undefined") return;
  if (path === window.location.pathname) return;
  if (options?.replace === true) {
    window.history.replaceState(null, "", path);
  } else {
    window.history.pushState(null, "", path);
  }
  pathBox.set?.(window.location.pathname);
}
