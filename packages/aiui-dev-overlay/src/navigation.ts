/**
 * The navigation watcher: page-side machinery that notices **same-document
 * navigations** — an SPA router pushing a route, a hash jump, a back/forward
 * traversal — and reports them as structured changes. The third watcher,
 * beside selection (selection.ts) and interaction (multimodal/interaction.ts).
 *
 * Design decisions (docs/proposals/spa-navigation-and-turn-continuity.md,
 * Proposal 1):
 *  - **Router-agnostic by construction.** Prefer the Navigation API
 *    (`window.navigation`'s `currententrychange` — it fires once per COMMITTED
 *    same-document navigation, uniformly for pushState/replaceState/traversal/
 *    hash, with the previous entry and the navigation type attached). Fallback
 *    for engines without it: patch `history.pushState`/`replaceState` and
 *    listen to `popstate` + `hashchange` — the same technique analytics SDKs
 *    use for SPA page tracking. Every client-side router bottoms out in these
 *    primitives; no per-framework adapters.
 *  - **Observation only.** The watcher cannot make an app SPA-navigate — a
 *    bare `<a href>` the router doesn't intercept is a hard navigation and the
 *    document (watcher included) dies exactly as before. It reports what the
 *    page did; policy (the `navigation` intent event, ink clearing, selection
 *    retraction) lives with the consumers.
 *  - **`pathChanged` is the policy hinge.** A pathname change is a "page"
 *    change (destructive context policies apply: ink, selections); a
 *    same-path change (hash jump to a section, replaceState syncing app state
 *    into the query string) is context worth tracing but nothing worth
 *    clearing over.
 *  - **Ships unconditionally.** In an MPA the document dies before the watcher
 *    matters, so installing it everywhere is free.
 */

/** How the navigation happened, when the mechanism can cheaply tell. */
export type NavigationKind = "push" | "replace" | "traverse" | "reload" | "hash";

/** One committed same-document navigation. */
export interface NavigationChange {
  /** `location.href` before the navigation. */
  from: string;
  /** `location.href` after the navigation. */
  to: string;
  /** Attribution when available (Navigation API always; fallback best-effort). */
  kind?: NavigationKind;
  /**
   * True when the *pathname* changed — the "this is a different page" signal
   * consumers key destructive policies on. Hash and query-only changes
   * (section jumps, state-in-URL syncing) leave it false.
   */
  pathChanged: boolean;
}

/** Handle over a running navigation watcher. */
export interface NavigationWatcher {
  /** Stop listening and undo any history patching. Idempotent. */
  dispose(): void;
}

export interface NavigationWatcherOptions {
  /** Called once per committed same-document navigation. */
  onNavigate: (change: NavigationChange) => void;
}

/** Pathname comparison between two hrefs; malformed URLs compare as strings. */
function pathnameChanged(from: string, to: string): boolean {
  try {
    return new URL(from).pathname !== new URL(to).pathname;
  } catch {
    return from !== to;
  }
}

const NOOP_WATCHER: NavigationWatcher = { dispose() {} };

/** The Navigation API surface we consume (absent in Firefox/Safari/jsdom). */
interface NavigationLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/**
 * Install a same-document navigation watcher. No-ops (returns a safe handle)
 * without a DOM. See the module doc for mechanism and rationale.
 */
export function installNavigationWatcher(opts: NavigationWatcherOptions): NavigationWatcher {
  if (typeof window === "undefined" || typeof location === "undefined") {
    return NOOP_WATCHER;
  }

  let lastHref = location.href;
  const report = (kind: NavigationKind | undefined): void => {
    const to = location.href;
    const from = lastHref;
    if (to === from) {
      return; // replaceState to the same URL, a swallowed hashchange — noise
    }
    lastHref = to;
    opts.onNavigate({
      from,
      to,
      ...(kind !== undefined ? { kind } : {}),
      pathChanged: pathnameChanged(from, to),
    });
  };

  // ── preferred: the Navigation API ──────────────────────────────────────────
  const navigation = (window as { navigation?: NavigationLike }).navigation;
  if (navigation !== undefined && typeof navigation.addEventListener === "function") {
    // `currententrychange` fires once per committed same-document navigation —
    // exactly the boundary we want (`navigate` also fires for cross-document
    // and cancelable ones; too early, and moot: those kill this watcher).
    const onChange = (event: unknown): void => {
      const e = event as { navigationType?: string | null };
      const kind =
        e.navigationType === "push" ||
        e.navigationType === "replace" ||
        e.navigationType === "traverse" ||
        e.navigationType === "reload"
          ? e.navigationType
          : undefined;
      report(kind);
    };
    navigation.addEventListener("currententrychange", onChange);
    let disposed = false;
    return {
      dispose(): void {
        if (!disposed) {
          disposed = true;
          navigation.removeEventListener("currententrychange", onChange);
        }
      },
    };
  }

  // ── fallback: history patching + popstate/hashchange ───────────────────────
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  function patchedPushState(this: History, ...args: Parameters<History["pushState"]>): void {
    origPush.apply(this, args);
    report("push");
  }
  function patchedReplaceState(this: History, ...args: Parameters<History["replaceState"]>): void {
    origReplace.apply(this, args);
    report("replace");
  }
  history.pushState = patchedPushState;
  history.replaceState = patchedReplaceState;
  const onPopState = (): void => report("traverse");
  // An anchor click to `#section` fires hashchange with no pushState involved;
  // popstate-covered traversals are deduped by `report`'s same-href guard
  // (popstate runs first and advances lastHref).
  const onHashChange = (): void => report("hash");
  window.addEventListener("popstate", onPopState);
  window.addEventListener("hashchange", onHashChange);

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      // Only unpatch if nobody patched over us since (last-in wins otherwise).
      if (history.pushState === patchedPushState) {
        history.pushState = origPush;
      }
      if (history.replaceState === patchedReplaceState) {
        history.replaceState = origReplace;
      }
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onHashChange);
    },
  };
}
