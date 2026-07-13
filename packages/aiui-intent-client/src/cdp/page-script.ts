/**
 * page-script.ts — the bootstrap the CdpBus injects into EVERY document
 * (Page.addScriptToEvaluateOnNewDocument + a catch-up Runtime.evaluate — the
 * installCaptureMarker pattern). It is the CDP tier's stand-in for the old
 * extension's content script:
 *
 *  - reports world facts through the `__aiuiIntentReport` binding: hello
 *    (url/visibility/aiui-instrumentation), focus changes (the ACTIVE-TAB
 *    signal — callback-based, no polling), selection presence, interaction
 *    pings (the smart-video gate), SPA navigations, captured keys;
 *  - serves the page capabilities under `window.__aiuiIntentPage.handle`:
 *    ring · flash · keylayer · selection · viewport · ink · locate.
 *
 * **The page fetches nothing.** Not the bootstrap (it arrives as a string over
 * CDP), and not the heavy ink surface (the bus evaluates its bundle into the
 * page — see cdp-bus's `ensureInk`). An https page may not load a module from
 * the channel's `http://127.0.0.1:…` origin: that is mixed content, and it is
 * most of the web. Found live — the ring appeared on example.com and the ink,
 * quietly, did not.
 *
 * Authored as a real function (so it typechecks) and stringified for
 * injection by `buildPageScript()`.
 */

/** What one instrumented document reports — the page→panel contract, shared by
 * BOTH hosts (the extension's content script speaks it too; see ext/protocol). */
export type PageReport =
  | { kind: "hello"; url: string; title: string; visible: boolean; focused: boolean; aiui: boolean }
  | { kind: "focus"; visible: boolean; focused: boolean }
  | { kind: "selection"; present: boolean }
  | { kind: "interaction" }
  | {
      kind: "navigation";
      from: string;
      to: string;
      navKind: "push" | "replace" | "traverse" | "hash";
    }
  | { kind: "key"; key: string; phase: "down" | "up"; repeat: boolean }
  | { kind: "stroke"; points: number }
  /** The FROZEN client has this tab armed (its ring says so). Two clients
   * inking one page is nonsense, so the new one stands down — see the
   * coexistence policy in the client's README. */
  | { kind: "foreign"; armed: boolean };

const BINDING = "__aiuiIntentReport";

/* The function below runs INSIDE arbitrary pages. Keep it dependency-free,
 * idempotent, and defensive — it must never break a host page. */
function pageBootstrap(version: string): void {
  const w = window as unknown as Record<string, unknown>;
  const installed = w.__aiuiIntentPage as { v?: string; adopt?: () => void } | undefined;
  if (installed?.v === version && installed.adopt !== undefined) {
    // Already carrying a bootstrap — but from WHICH client? A reloaded panel
    // (or a second one) re-attaches to this same live document and installs a
    // NEW binding over the old one. Re-running the install would double every
    // listener, and returning silently would leave the new client deaf: the
    // page would never say hello, so it would have no url, no focus, no tab.
    // So: hand the document over — drop what the last client asserted, and
    // re-announce to the binding that is live now. (Found live, Phase 3.)
    installed.adopt();
    return;
  }
  // A DIFFERENT version (you edited this file and reloaded the panel) or
  // something else under that name: install over it. `adopt` would keep the
  // stale code running — which, in dev, means testing the bootstrap you just
  // replaced. A few doubled reports beat that; the page's next load is clean.
  const report = (payload: unknown): void => {
    try {
      (w.__aiuiIntentReport as (s: string) => void)?.(JSON.stringify(payload));
    } catch {
      // the binding may not exist yet (pre-attach evaluate) — facts re-report
    }
  };

  // ── the ring: the page's ONLY evidence of the client's state ──────────────
  let ring: HTMLElement | undefined;
  const assertRing = (on: boolean, turnTone: boolean): void => {
    if (!on) {
      ring?.remove();
      ring = undefined;
      return;
    }
    if (ring === undefined || !ring.isConnected) {
      ring = document.createElement("div");
      ring.id = "__aiui-intent-ring";
      ring.style.cssText =
        "position:fixed;top:8px;right:8px;width:12px;height:12px;border-radius:50%;" +
        "z-index:2147483646;pointer-events:none;transition:background 200ms;";
      const style = document.createElement("style");
      style.textContent =
        "@keyframes __aiui-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}";
      ring.appendChild(style);
      (document.body ?? document.documentElement).appendChild(ring);
    }
    ring.style.background = turnTone ? "#dc2626" : "#7c3aed";
    ring.style.animation = turnTone ? "__aiui-breathe 1.6s ease-in-out infinite" : "none";
  };

  // ── flash: shot confirmation / miss feedback ───────────────────────────────
  const flash = (kind: string): void => {
    const wash = document.createElement("div");
    wash.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none;transition:opacity 220ms;" +
      `background:${kind === "miss" ? "rgba(220,38,38,.25)" : "rgba(147,197,253,.35)"};`;
    (document.body ?? document.documentElement).appendChild(wash);
    requestAnimationFrame(() => {
      wash.style.opacity = "0";
      setTimeout(() => wash.remove(), 260);
    });
  };

  // ── keylayer: the in-turn wholesale key claim, forwarded to the panel ─────
  let keyHandlers: { down: (e: KeyboardEvent) => void; up: (e: KeyboardEvent) => void } | undefined;
  const setKeyCapture = (capture: boolean): void => {
    if (!capture) {
      if (keyHandlers !== undefined) {
        document.removeEventListener("keydown", keyHandlers.down, true);
        document.removeEventListener("keyup", keyHandlers.up, true);
        keyHandlers = undefined;
      }
      return;
    }
    if (keyHandlers !== undefined) {
      return;
    }
    const forward = (phase: "down" | "up") => (event: KeyboardEvent) => {
      // Never claim browser chords (⌘L, ⌘T…) — the wholesale claim is for
      // ordinary keys; the panel's grammar decides swallow-vs-command.
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      report({ kind: "key", key: event.key, phase, repeat: event.repeat });
    };
    keyHandlers = { down: forward("down"), up: forward("up") };
    document.addEventListener("keydown", keyHandlers.down, true);
    document.addEventListener("keyup", keyHandlers.up, true);
  };

  // ── ink: the real surface, INJECTED by the bus (never fetched by the page) ─
  //
  // The page pulls nothing over the network. An https page cannot import a
  // module from the channel's `http://127.0.0.1:…` origin — mixed content, and
  // that is most of the web (found live: ring on example.com, ink silently
  // absent). So the bus evaluates the bundle here first, and this handler just
  // uses the global it defines.
  let inkHandle:
    | { setOn: (on: boolean, fadeSec: number) => void; clear: () => void; dispose: () => void }
    | undefined;
  const handleInk = (payload: { on?: boolean; fadeSec?: number; clear?: boolean }): unknown => {
    const ink = w.__aiuiIntentInk as
      | { mountInk: (report: (points: number) => void) => typeof inkHandle }
      | undefined;
    if (payload.clear === true) {
      inkHandle?.clear();
      return { ok: true };
    }
    if (payload.on === true) {
      if (inkHandle === undefined) {
        if (ink === undefined) {
          return { error: "the ink surface was not injected" };
        }
        inkHandle = ink.mountInk((points) => report({ kind: "stroke", points }));
      }
      inkHandle?.setOn(true, payload.fadeSec ?? 0);
      return { ok: true };
    }
    inkHandle?.setOn(false, 0);
    return { ok: true };
  };

  // ── world facts, callback-based ────────────────────────────────────────────
  const facts = (): { visible: boolean; focused: boolean } => ({
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
  });
  const sayHello = (): void => {
    report({
      kind: "hello",
      url: location.href,
      title: document.title,
      ...facts(),
      aiui: (w.__AIUI__ ?? undefined) !== undefined,
    });
  };

  // ── the capability surface (the relay's command set, CDP-delivered) ───────
  w.__aiuiIntentPage = {
    /** Which build of this bootstrap is live in the document (see the guard). */
    v: version,
    /** A new client took this document over (see the install guard): forget the
     * last one's assertions, then re-announce to the binding that is live now.
     * Ink STROKES survive — they are the user's, not the client's. */
    adopt: (): void => {
      setKeyCapture(false);
      assertRing(false, false);
      sayHello();
    },
    hello: sayHello,
    handle: (capability: string, payload: Record<string, unknown> | undefined): unknown => {
      switch (capability) {
        case "ring": {
          assertRing(payload?.on === true, payload?.turnTone === true);
          return { ok: true };
        }
        case "flash": {
          flash(String(payload?.kind ?? "shot"));
          return { ok: true };
        }
        case "keylayer": {
          setKeyCapture(payload?.capture === true);
          return { ok: true };
        }
        case "selection": {
          const selection = window.getSelection?.();
          const text = selection?.toString() ?? "";
          return text.trim() === "" ? null : { text, url: location.href, title: document.title };
        }
        case "viewport": {
          return { ok: true }; // sampling rides CDP screenshots panel-side
        }
        case "ink": {
          return handleInk((payload ?? {}) as never);
        }
        case "locate": {
          return null; // instrumented-page jump: anticipated, post-parity
        }
        default:
          return { error: `unknown capability: ${capability}` };
      }
    },
  };

  // ── world facts, callback-based (no polling: the panel learns by report) ──
  const reportFocus = (): void => {
    report({ kind: "focus", ...facts() });
  };
  document.addEventListener("visibilitychange", reportFocus);
  window.addEventListener("focus", reportFocus);
  window.addEventListener("blur", reportFocus);

  let selectionWas = false;
  document.addEventListener("selectionchange", () => {
    const present = (window.getSelection?.()?.toString() ?? "").trim() !== "";
    if (present !== selectionWas) {
      selectionWas = present;
      report({ kind: "selection", present });
    }
  });

  // The FROZEN client injects into this same page. We cannot talk to it, but we
  // share a DOM: its indicator's shadow root wears an `armed` class while it
  // holds the tab. Watch it, report it, and let the panel stand down rather
  // than fight for the page (the coexistence policy — README).
  let foreignWas = false;
  const checkForeign = (): void => {
    const host = document.getElementById("aiui-webext-indicator-host");
    const root = host?.shadowRoot?.querySelector("div");
    const armed = root instanceof HTMLElement && root.classList.contains("armed");
    if (armed !== foreignWas) {
      foreignWas = armed;
      report({ kind: "foreign", armed });
    }
  };
  const legacyRoot = document.getElementById("aiui-webext-indicator-host")?.shadowRoot;
  if (legacyRoot != null) {
    new MutationObserver(checkForeign).observe(legacyRoot, {
      attributes: true,
      subtree: true,
      attributeFilter: ["class"],
    });
    checkForeign();
  }

  let lastInteraction = 0;
  const interaction = (): void => {
    const now = Date.now();
    if (now - lastInteraction > 1000) {
      lastInteraction = now;
      report({ kind: "interaction" });
    }
  };
  document.addEventListener("pointerdown", interaction, true);
  document.addEventListener("keydown", interaction, true);
  document.addEventListener("wheel", interaction, { capture: true, passive: true });

  // SPA navigations (full loads re-run this bootstrap and re-hello).
  let hereUrl = location.href;
  const nav = (navKind: "push" | "replace" | "traverse" | "hash") => (): void => {
    const to = location.href;
    if (to !== hereUrl) {
      report({ kind: "navigation", from: hereUrl, to, navKind });
      hereUrl = to;
    }
  };
  const history = window.history as unknown as Record<string, (...args: unknown[]) => unknown>;
  const wrap = (name: string, navKind: "push" | "replace"): void => {
    const original = history[name].bind(window.history);
    history[name] = (...args: unknown[]) => {
      const out = original(...args);
      nav(navKind)();
      return out;
    };
  };
  wrap("pushState", "push");
  wrap("replaceState", "replace");
  window.addEventListener("popstate", nav("traverse"));
  window.addEventListener("hashchange", nav("hash"));

  sayHello();
}

/** The injectable source, with the channel origin baked in. */
export function buildPageScript(): string {
  const source = pageBootstrap.toString();
  return `(${source})(${JSON.stringify(fingerprint(source))});`;
}

/** A cheap content hash: the bootstrap's identity, so a document carrying an
 * older build gets replaced rather than adopted (FNV-1a, 32-bit). */
function fingerprint(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export const PAGE_REPORT_BINDING = BINDING;
