/**
 * navigation.test.ts — the navigation watcher (navigation.ts): the history-
 * patching fallback exercised against jsdom's real History API, and the
 * Navigation API path against a stubbed `window.navigation` (jsdom has none,
 * which conveniently lets one suite cover both mechanisms).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  installNavigationWatcher,
  type NavigationChange,
  type NavigationWatcher,
} from "./navigation";

let watcher: NavigationWatcher | undefined;

afterEach(() => {
  watcher?.dispose();
  watcher = undefined;
  // Leave the URL somewhere fixed so tests don't order-couple.
  history.replaceState(null, "", "/");
});

function collect(): NavigationChange[] {
  const changes: NavigationChange[] = [];
  watcher = installNavigationWatcher({ onNavigate: (c) => changes.push(c) });
  return changes;
}

describe("history-patching fallback (jsdom has no Navigation API)", () => {
  it("reports pushState with kind push and pathChanged", () => {
    history.replaceState(null, "", "/start");
    const changes = collect();
    history.pushState(null, "", "/aztec");
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("push");
    expect(changes[0].pathChanged).toBe(true);
    expect(new URL(changes[0].from).pathname).toBe("/start");
    expect(new URL(changes[0].to).pathname).toBe("/aztec");
  });

  it("reports replaceState with kind replace; query-only change keeps pathChanged false", () => {
    history.replaceState(null, "", "/page");
    const changes = collect();
    history.replaceState(null, "", "/page?mc=4.5");
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("replace");
    expect(changes[0].pathChanged).toBe(false);
  });

  it("a hash-only change keeps pathChanged false", () => {
    history.replaceState(null, "", "/page");
    const changes = collect();
    history.pushState(null, "", "/page#theory");
    expect(changes).toHaveLength(1);
    expect(changes[0].pathChanged).toBe(false);
  });

  it("swallows a same-URL replaceState (noise, not a navigation)", () => {
    history.replaceState(null, "", "/page");
    const changes = collect();
    history.replaceState(null, "", "/page");
    expect(changes).toHaveLength(0);
  });

  it("reports popstate as a traverse", () => {
    history.replaceState(null, "", "/a");
    const changes = collect();
    // jsdom's history.back() is async-ish and unreliable; simulate the
    // browser's traversal: the URL has already changed when popstate fires.
    history.replaceState(null, "", "/b"); // (counts as one replace)
    window.dispatchEvent(new PopStateEvent("popstate"));
    // The replace already advanced lastHref, so the popstate alone adds
    // nothing; now move the URL underneath and fire popstate like a real
    // back button does.
    const origReplace = History.prototype.replaceState;
    origReplace.call(history, null, "", "/a"); // move URL without the patch seeing it
    window.dispatchEvent(new PopStateEvent("popstate"));
    const traversals = changes.filter((c) => c.kind === "traverse");
    expect(traversals).toHaveLength(1);
    expect(new URL(traversals[0].from).pathname).toBe("/b");
    expect(new URL(traversals[0].to).pathname).toBe("/a");
  });

  it("dispose unpatches history and stops reporting", () => {
    const origPush = history.pushState;
    const changes = collect();
    expect(history.pushState).not.toBe(origPush);
    watcher?.dispose();
    expect(history.pushState).toBe(origPush);
    history.pushState(null, "", "/after-dispose");
    expect(changes).toHaveLength(0);
  });

  it("dispose is idempotent and respects a later patcher (last-in wins)", () => {
    const before = history.pushState;
    collect();
    const laterPatch = (() => {}) as typeof history.pushState;
    history.pushState = laterPatch;
    watcher?.dispose();
    watcher?.dispose();
    // We were not the current patch, so dispose must leave the later one alone.
    expect(history.pushState).toBe(laterPatch);
    history.pushState = before; // restore for the other tests
  });
});

describe("Navigation API path (stubbed window.navigation)", () => {
  interface StubNavigation {
    addEventListener(type: string, listener: (event: unknown) => void): void;
    removeEventListener(type: string, listener: (event: unknown) => void): void;
    fire(navigationType: string | null): void;
    listeners: number;
  }

  function stubNavigation(): StubNavigation {
    const handlers = new Set<(event: unknown) => void>();
    return {
      addEventListener(type, listener) {
        if (type === "currententrychange") {
          handlers.add(listener);
        }
      },
      removeEventListener(type, listener) {
        if (type === "currententrychange") {
          handlers.delete(listener);
        }
      },
      fire(navigationType) {
        for (const h of handlers) {
          h({ navigationType });
        }
      },
      get listeners() {
        return handlers.size;
      },
    };
  }

  afterEach(() => {
    (window as { navigation?: unknown }).navigation = undefined;
  });

  it("prefers navigation.currententrychange and maps navigationType", () => {
    const nav = stubNavigation();
    (window as { navigation?: unknown }).navigation = nav;
    history.replaceState(null, "", "/from");
    const changes = collect();
    // The Navigation API path does NOT patch history: move the URL first,
    // then fire the committed-change event, as the browser does.
    history.replaceState(null, "", "/to");
    expect(changes).toHaveLength(0); // no history patch in this mode
    nav.fire("push");
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("push");
    expect(changes[0].pathChanged).toBe(true);
    expect(new URL(changes[0].from).pathname).toBe("/from");
  });

  it("passes unknown navigationType through as undefined kind, and dispose unhooks", () => {
    const nav = stubNavigation();
    (window as { navigation?: unknown }).navigation = nav;
    history.replaceState(null, "", "/x");
    const changes = collect();
    history.replaceState(null, "", "/y");
    nav.fire(null);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBeUndefined();
    watcher?.dispose();
    expect(nav.listeners).toBe(0);
  });
});
