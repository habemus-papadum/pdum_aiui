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
 *    ring · flash · keylayer · selection · viewport · pencil · jump · locate.
 *
 * **The page fetches nothing.** Not the bootstrap (it arrives as a string over
 * CDP), and not the heavy page bundle (the bus evaluates it into the page —
 * see cdp-bus's `ensureBundle`). An https page may not load a module from
 * the channel's `http://127.0.0.1:…` origin: that is mixed content, and it is
 * most of the web. Found live — the ring appeared on example.com and the
 * surfaces, quietly, did not.
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
  /** A completed region drag (the armed `a` gesture): rect + viewport in CSS
   * px, the pointerup wall-clock, and located components when the page is
   * aiui-instrumented (the evaluated bundle's locator). */
  | {
      kind: "region";
      rect: { x: number; y: number; w: number; h: number };
      viewport: { w: number; h: number };
      takenAt: number;
      components?: unknown[];
    }
  | { kind: "stroke"; points: number }
  /** A jump pick finished — committed (VS Code opens) or cancelled (Esc /
   * click-away). Auto-exits jump mode (owner, 2026-07-16). */
  | { kind: "jumpDone" }
  /** The page's `__AIUI__.tools` registry — full current set, descriptors only. */
  | {
      kind: "tools";
      registrations: Array<{
        ns: string;
        tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
      }>;
    }
  /** A `toolsCall` capability's answer, correlated by callId. */
  | { kind: "toolsResult"; callId: string; ok: boolean; value?: unknown; error?: string }
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
  // Four states: off · steady (armed) · breathing (turn) · HOLLOW — armed, but
  // this tab's pixels need a grant. Hollow renders outline-only with the
  // activation hint beside it; the hint TEXT is whatever the host handed down
  // (the live shortcut binding) — this page never knows what the key is.
  let ring: HTMLElement | undefined;
  let ringHint: HTMLElement | undefined;
  const assertRing = (on: boolean, turnTone: boolean, hollow: boolean, hint: string): void => {
    if (!on) {
      ring?.remove();
      ringHint?.remove();
      ring = undefined;
      ringHint = undefined;
      return;
    }
    if (ring === undefined || !ring.isConnected) {
      ring = document.createElement("div");
      ring.id = "__aiui-intent-ring";
      ring.style.cssText =
        "position:fixed;top:8px;right:8px;width:12px;height:12px;border-radius:50%;" +
        "box-sizing:border-box;z-index:2147483646;pointer-events:none;transition:background 200ms;";
      const style = document.createElement("style");
      style.textContent =
        "@keyframes __aiui-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}";
      ring.appendChild(style);
      (document.body ?? document.documentElement).appendChild(ring);
    }
    const color = turnTone ? "#dc2626" : "#7c3aed";
    ring.style.background = hollow ? "transparent" : color;
    ring.style.border = hollow ? `2px solid ${color}` : "0";
    ring.style.animation = turnTone ? "__aiui-breathe 1.6s ease-in-out infinite" : "none";
    if (hollow && hint !== "") {
      if (ringHint === undefined || !ringHint.isConnected) {
        ringHint = document.createElement("div");
        ringHint.id = "__aiui-intent-ring-hint";
        ringHint.style.cssText =
          "position:fixed;top:7px;right:24px;z-index:2147483646;pointer-events:none;" +
          "font:11px/14px ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 5px;" +
          "border-radius:7px;background:rgba(0,0,0,.55);color:#fff;";
        (document.body ?? document.documentElement).appendChild(ringHint);
      }
      ringHint.textContent = hint;
    } else {
      ringHint?.remove();
      ringHint = undefined;
    }
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

  // ── the page bundle: INJECTED by the bus (never fetched by the page) ───────
  //
  // The page pulls nothing over the network. An https page cannot import a
  // module from the channel's `http://127.0.0.1:…` origin — mixed content, and
  // that is most of the web (found live: ring on example.com, surfaces
  // silently absent). So the bus evaluates the bundle first, and the handlers
  // below just use the global it defines.

  // ── pencil: the same evaluated bundle, a second surface (local + remote) ────
  // One `mountPencil()` handle, engaged for the turn; the panel drives it with
  // `{op, …}` payloads (engage/fade/clear/undo and the forwarded iPad strokes).
  type PencilHandle = {
    engage: (fadeSec: number) => void;
    disengage: () => void;
    setFade: (fadeSec: number) => void;
    clear: () => void;
    undo: () => void;
    size: () => { width: number; height: number };
    remoteBegin: (id: string, init: unknown) => void;
    remotePoint: (id: string, point: unknown) => void;
    remoteEnd: (id: string, point?: unknown) => void;
    remoteCancel: (id: string) => void;
  };
  let pencilHandle: PencilHandle | undefined;
  const handlePencil = (payload: Record<string, unknown>): unknown => {
    const mount = (w.__aiuiIntentPage as { mountPencil?: () => PencilHandle } | undefined)
      ?.mountPencil;
    const op = String(payload.op ?? "");
    if (op === "engage") {
      if (mount === undefined) {
        return { error: "the pencil surface was not injected" };
      }
      pencilHandle ??= mount();
      pencilHandle.engage(Number(payload.fadeSec ?? 0));
      return { ok: true };
    }
    if (pencilHandle === undefined) {
      return { ok: true }; // nothing mounted yet — a stray op after disengage
    }
    switch (op) {
      case "disengage":
        // Keep the handle (and its strokes) — disengage only stops owning the
        // pointer. Re-engage reuses the same surface, so markup survives
        // across turns.
        pencilHandle.disengage();
        return { ok: true };
      case "fade":
        pencilHandle.setFade(Number(payload.fadeSec ?? 0));
        return { ok: true };
      case "clear":
        pencilHandle.clear();
        return { ok: true };
      case "undo":
        pencilHandle.undo();
        return { ok: true };
      case "size":
        return pencilHandle.size();
      case "rbegin":
        pencilHandle.remoteBegin(String(payload.id), payload.init);
        return { ok: true };
      case "rpoint":
        pencilHandle.remotePoint(String(payload.id), payload.point);
        return { ok: true };
      case "rend":
        pencilHandle.remoteEnd(String(payload.id), payload.point);
        return { ok: true };
      case "rcancel":
        pencilHandle.remoteCancel(String(payload.id));
        return { ok: true };
      default:
        return { error: `unknown pencil op: ${op}` };
    }
  };

  // ── world facts, callback-based ────────────────────────────────────────────
  const facts = (): { visible: boolean; focused: boolean } => ({
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
  });
  /** What the last hello CLAIMED about instrumentation — the poll below
   * corrects the record when `__AIUI__` lands after we said false. */
  let saidAiui = false;
  const sayHello = (): void => {
    setTimeout(reportTools, 0); // after the hello: the current tool set

    saidAiui = (w.__AIUI__ ?? undefined) !== undefined;
    report({
      kind: "hello",
      url: location.href,
      title: document.title,
      ...facts(),
      aiui: saidAiui,
    });
  };

  // ── page tools: watch __AIUI__.tools, report descriptors (the T2 bridge) ──
  // The registry installs whenever the app's agentToolkit first runs — which
  // may be AFTER this bootstrap. A light poll subscribes once it appears,
  // then stops; onChange carries every later update.
  type ToolsRegistry = {
    list(): Array<{
      ns: string;
      tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
    }>;
    call(ns: string, name: string, args?: unknown): Promise<unknown>;
    onChange(handler: () => void): () => void;
  };
  const toolsRegistry = (): ToolsRegistry | undefined =>
    (w.__AIUI__ as { tools?: ToolsRegistry } | undefined)?.tools;
  const reportTools = (): void => {
    const registry = toolsRegistry();
    if (registry?.list === undefined) {
      return;
    }
    report({
      kind: "tools",
      registrations: registry.list().map((entry) => ({
        ns: entry.ns,
        tools: entry.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        })),
      })),
    });
  };
  let toolsWatched = false;
  const watchTools = (): void => {
    const registry = toolsRegistry();
    if (toolsWatched || registry?.onChange === undefined) {
      return;
    }
    toolsWatched = true;
    registry.onChange(reportTools);
    reportTools();
  };
  watchTools();
  const toolsPoll = setInterval(() => {
    watchTools();
    // The late-instrumentation correction (found live, 2026-07-16): on a
    // FRESH navigation this bootstrap runs at document-start, before the
    // app's runtime installs `__AIUI__`, so the first hello says aiui:false —
    // and nothing corrected it until the next visibilitychange (the pill sat
    // gray after every dev-server reload). The MV3 probe re-hellos when the
    // global appears (content-main.ts); this is that correction, CDP tier.
    if (!saidAiui && (w.__AIUI__ ?? undefined) !== undefined) {
      sayHello();
    }
    if (toolsWatched && saidAiui) {
      clearInterval(toolsPoll);
    }
  }, 2000);

  // ── the region rubber band: a ONE-SHOT drag overlay (the `a` area shot) ───
  let regionOverlay: HTMLElement | undefined;
  const disarmRegion = (): void => {
    regionOverlay?.remove();
    regionOverlay = undefined;
  };
  const armRegion = (): void => {
    disarmRegion(); // re-arm replaces
    const overlay = document.createElement("div");
    overlay.id = "__aiui-intent-region";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;cursor:crosshair;background:rgba(124,58,237,.06);";
    const band = document.createElement("div");
    band.style.cssText =
      "position:fixed;border:2px solid #7c3aed;background:rgba(124,58,237,.12);display:none;" +
      "pointer-events:none;";
    overlay.appendChild(band);
    let start: { x: number; y: number } | undefined;
    const rectNow = (e: PointerEvent) => {
      const s0 = start ?? { x: e.clientX, y: e.clientY };
      return {
        x: Math.min(s0.x, e.clientX),
        y: Math.min(s0.y, e.clientY),
        w: Math.abs(e.clientX - s0.x),
        h: Math.abs(e.clientY - s0.y),
      };
    };
    overlay.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY };
      overlay.setPointerCapture(e.pointerId);
    });
    overlay.addEventListener("pointermove", (e) => {
      if (start === undefined) {
        return;
      }
      const r = rectNow(e);
      band.style.display = "block";
      band.style.left = `${r.x}px`;
      band.style.top = `${r.y}px`;
      band.style.width = `${r.w}px`;
      band.style.height = `${r.h}px`;
    });
    overlay.addEventListener("pointerup", (e) => {
      const r = start !== undefined ? rectNow(e) : undefined;
      disarmRegion();
      if (r === undefined || r.w < 4 || r.h < 4) {
        return; // a click, not a drag — cancelled
      }
      // Located components when this page is aiui-instrumented and the
      // evaluated bundle is present (ensureBundle delivered it).
      let components: unknown[] | undefined;
      try {
        const locate = (w.__aiuiIntentPage as { locateComponents?: (r: unknown) => unknown[] })
          ?.locateComponents;
        components = locate?.(r);
      } catch {
        components = undefined;
      }
      report({
        kind: "region",
        rect: r,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        takenAt: Date.now(),
        ...(components !== undefined && components.length > 0 ? { components } : {}),
      });
    });
    // No private Escape listener (owner, 2026-07-16): area is a mode-engine
    // TOGGLE now, and Escape unwinds it through the panel's escOrder — the in-turn
    // key layer forwards Escape to the panel, which flips `region` off, and the
    // regionSurface claim lowers this overlay. One Escape source, no split-brain.
    (document.body ?? document.documentElement).appendChild(overlay);
    regionOverlay = overlay;
  };

  // ── driver liveness: self-cleanup when the panel dies mid-assertion ───────
  // INLINE TWIN of page/driver-watch.ts (this function may import nothing at
  // runtime — keep the two aligned). Assertion-carrying requests note proof of
  // life; the panel beats `heartbeat` with its per-boot session id. Silence
  // past the timeout = the panel tab died mid-turn → HARD cleanup (the
  // strokes belong to a dead session). A NEW session id = a reloaded panel →
  // soft reset; strokes survive (the `adopt` rule — turn recovery must find
  // its markup) and the new client re-asserts through the ordinary paths.
  const DRIVER_TIMEOUT_MS = 2500; // transport.ts DRIVER_TIMEOUT_MS — aligned
  const DRIVER_CHECK_MS = 833; // max(250, timeout/3) — driver-watch.ts, aligned
  let driverSession: string | undefined;
  let driverLast = 0;
  let driverLastCheck = 0;
  let driverTimer: number | undefined;
  const dropAssertions = (): void => {
    setKeyCapture(false);
    assertRing(false, false, false, "");
    disarmRegion();
    (w.__aiuiIntentPage as { disarmJump?: () => void } | undefined)?.disarmJump?.();
    handlePencil({ op: "disengage" });
  };
  const driverAlive = (session?: string): void => {
    if (session !== undefined && session !== "") {
      if (driverSession !== undefined && driverSession !== session) {
        dropAssertions();
      }
      driverSession = session;
    }
    driverLast = Date.now();
    if (driverTimer === undefined) {
      driverLastCheck = Date.now();
      driverTimer = window.setInterval(() => {
        const now = Date.now();
        const stalled = now - driverLastCheck > DRIVER_CHECK_MS * 2;
        driverLastCheck = now;
        if (stalled) {
          // The page stalled (GC, debugger, heavy frame): beats froze WITH
          // this check — give the queued ones a round before convicting
          // (driver-watch.ts, aligned; matters at the tightened timeout).
          return;
        }
        if (now - driverLast > DRIVER_TIMEOUT_MS) {
          window.clearInterval(driverTimer);
          driverTimer = undefined;
          driverSession = undefined;
          handlePencil({ op: "clear" });
          dropAssertions();
        }
      }, DRIVER_CHECK_MS);
    }
  };

  // ── the capability surface (the relay's command set, CDP-delivered) ───────
  w.__aiuiIntentPage = {
    /** Which build of this bootstrap is live in the document (see the guard). */
    v: version,
    /** A new client took this document over (see the install guard): forget the
     * last one's assertions, then re-announce to the binding that is live now.
     * Pencil STROKES survive — they are the user's, not the client's. */
    adopt: (): void => {
      setKeyCapture(false);
      assertRing(false, false, false, "");
      disarmRegion();
      (w.__aiuiIntentPage as { disarmJump?: () => void } | undefined)?.disarmJump?.();
      sayHello();
    },
    hello: sayHello,
    handle: (capability: string, payload: Record<string, unknown> | undefined): unknown => {
      switch (capability) {
        case "heartbeat": {
          driverAlive(typeof payload?.session === "string" ? payload.session : "");
          return { ok: true };
        }
        case "ring": {
          driverAlive();
          assertRing(
            payload?.on === true,
            payload?.turnTone === true,
            payload?.hollow === true,
            typeof payload?.hint === "string" ? payload.hint : "",
          );
          return { ok: true };
        }
        case "flash": {
          flash(String(payload?.kind ?? "shot"));
          return { ok: true };
        }
        case "keylayer": {
          driverAlive();
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
        case "pencil": {
          driverAlive();
          return handlePencil((payload ?? {}) as Record<string, unknown>);
        }
        case "region": {
          driverAlive();
          if ((payload as { arm?: boolean } | undefined)?.arm === true) {
            armRegion();
          } else {
            disarmRegion();
          }
          return { ok: true };
        }
        case "toolsCall": {
          const p = (payload ?? {}) as {
            ns?: string;
            name?: string;
            args?: unknown;
            callId?: string;
          };
          const callId = String(p.callId ?? "");
          const registry = toolsRegistry();
          if (registry?.call === undefined) {
            report({ kind: "toolsResult", callId, ok: false, error: "no tools registry" });
            return { ok: true };
          }
          void Promise.resolve()
            .then(() => registry.call(String(p.ns ?? ""), String(p.name ?? ""), p.args))
            .then(
              (value) => report({ kind: "toolsResult", callId, ok: true, value }),
              (err: unknown) =>
                report({
                  kind: "toolsResult",
                  callId,
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                }),
            );
          return { ok: true };
        }
        case "jump": {
          // Jump-to-editor (the `j` pick mode) — the heavy half lives in the
          // evaluated bundle (jump-mode.ts); the bus delivers it before arming.
          const ink = w.__aiuiIntentPage as
            | {
                armJump?: (open?: (url: string) => void, onExit?: () => void) => void;
                disarmJump?: () => void;
              }
            | undefined;
          if ((payload as { arm?: boolean } | undefined)?.arm === true) {
            if (ink?.armJump === undefined) {
              return { error: "jump surface not delivered" };
            }
            // onExit: the page's completion signal — a committed or cancelled pick
            // reports `jumpDone`, and the panel auto-exits the mode (owner,
            // 2026-07-16). `undefined` open keeps jump-mode's default `vscode://`.
            ink.armJump(undefined, () => report({ kind: "jumpDone" }));
          } else {
            ink?.disarmJump?.();
          }
          return { ok: true };
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
