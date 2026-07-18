/**
 * page-script.ts — the bootstrap the CdpBus injects into EVERY document
 * (Page.addScriptToEvaluateOnNewDocument + a catch-up Runtime.evaluate — the
 * installCaptureMarker pattern). It is the CDP tier's twin of the MV3
 * client's content script (ext/content.ts):
 *
 *  - reports world facts through the `__aiuiIntentReport` binding: hello
 *    (url/visibility/aiui-instrumentation), focus changes (the ACTIVE-TAB
 *    signal — callback-based, no polling), selection presence, interaction
 *    pings (the smart-video gate), SPA navigations, captured keys;
 *  - serves the page capabilities under `window.__aiuiIntentPage.handle` — the
 *    `PageCapability` set (transport.ts's `PageCapabilityMap`, the single
 *    inventory; `ring` is in it, but is only ever BROADCAST, never requested).
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

import {
  type PageTabRecord,
  pageTabRecord,
} from "@habemus-papadum/aiui-intent-runtime/instrumentation";
import type { AiuiToolsRegistry } from "@habemus-papadum/aiui-viz";
import { createDriverWatch } from "../page/driver-watch";
import type { PencilHandle } from "../page/pencil-mount";
import {
  createFlash,
  createPencilOps,
  createRegionSurface,
  createRingSurface,
} from "../page/surfaces";
import { type CapError, DRIVER_TIMEOUT_MS, type PageCapabilityMap } from "../transport";

/** One page tool as it travels page→panel: the MCP-shaped subset of viz's
 * `AiuiPageTool` (no `run`). Structurally the channel's `PageToolDescriptor`,
 * which the tools-link test pins. */
export type PageToolDescriptorReport = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
};

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
      /** The DESTINATION's canonical tab record (`pageTabRecord`), when built. */
      tab?: PageTabRecord;
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
      registrations: Array<{ ns: string; tools: PageToolDescriptorReport[] }>;
    }
  /** A `toolsCall` capability's answer, correlated by callId. */
  | { kind: "toolsResult"; callId: string; ok: boolean; value?: unknown; error?: string };

const BINDING = "__aiuiIntentReport";

/** The self-contained pieces `buildPageScript` stringifies into the bootstrap:
 * the shared page surfaces (surfaces.ts), the driver watchdog (driver-watch.ts),
 * and the runtime's canonical tab-record builder (`pageTabRecord`). None of
 * them is a page-script-only reimplementation — they are the same code the MV3
 * content script imports, folded in as arguments so the page still fetches
 * nothing. Each source also joins the version fingerprint. */
interface PageBootstrapDeps {
  makeRing: typeof createRingSurface;
  makeFlash: typeof createFlash;
  makeRegion: typeof createRegionSurface;
  makePencilOps: typeof createPencilOps;
  makeDriverWatch: typeof createDriverWatch;
  driverTimeoutMs: number;
  tabRecord?: () => PageTabRecord | undefined;
}

/* The function below runs INSIDE arbitrary pages. Keep it dependency-free
 * (its only non-global VALUE references arrive through `deps`), idempotent, and
 * defensive — it must never break a host page. Type-only references are fine:
 * `import type` and inline `satisfies`/annotations erase before
 * `buildPageScript` stringifies this function, so they leave zero runtime trace
 * (a value import in this body would inject a ReferenceError into every page). */
function pageBootstrap(version: string, deps: PageBootstrapDeps): void {
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
  const { makeRing, makeFlash, makeRegion, makePencilOps, makeDriverWatch, driverTimeoutMs } = deps;
  const tabRecord = deps.tabRecord;
  const report = (payload: unknown): void => {
    try {
      (w.__aiuiIntentReport as (s: string) => void)?.(JSON.stringify(payload));
    } catch {
      // the binding may not exist yet (pre-attach evaluate) — facts re-report
    }
  };

  // ── the ring + the flash wash: the page's evidence of the client's state ──
  // Both are the shared surfaces (surfaces.ts), stringified in through `deps`
  // — one implementation with the MV3 content script (same ids, colors, CSS).
  const { assert: assertRing } = makeRing();
  const flash = makeFlash();

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
  // The `{op, …}` dispatcher is shared with the MV3 content script (surfaces.ts).
  // Here the mount arrives on the evaluated page bundle (`ensureBundle`) and is
  // absent until then — so `getMount` reads it off the global each engage, and
  // the factory answers when it is missing.
  const pencilOps = makePencilOps(
    () => (w.__aiuiIntentPage as { mountPencil?: () => PencilHandle } | undefined)?.mountPencil,
  );

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
  const toolsRegistry = (): AiuiToolsRegistry | undefined =>
    (w.__AIUI__ as { tools?: AiuiToolsRegistry } | undefined)?.tools;
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
  // Shared with the MV3 content script (surfaces.ts). `locate` reads the
  // evaluated bundle's component locator off the global, when the page has it.
  const { arm: armRegion, disarm: disarmRegion } = makeRegion({
    report,
    locate: (rect) =>
      (
        w.__aiuiIntentPage as { locateComponents?: (r: unknown) => unknown[] } | undefined
      )?.locateComponents?.(rect),
  });

  // ── driver liveness: self-cleanup when the panel dies mid-assertion ───────
  // The same watchdog the MV3 content script runs (page/driver-watch.ts),
  // stringified in through `deps` with transport.ts's DRIVER_TIMEOUT_MS.
  // Assertion-carrying requests note proof of life; the panel beats `heartbeat`
  // with its per-boot session id. Silence past the timeout → HARD cleanup
  // (strokes belong to a dead session); a NEW session id → soft reset (strokes
  // survive — the `adopt` rule — and the new client re-asserts through the
  // ordinary paths). An empty-string session counts as a session, so an
  // unnamed first beat still seeds the change detector.
  const dropAssertions = (): void => {
    setKeyCapture(false);
    assertRing(false, false, false, "");
    disarmRegion();
    (w.__aiuiIntentPage as { disarmJump?: () => void } | undefined)?.disarmJump?.();
    pencilOps({ op: "disengage" });
  };
  const driverWatch = makeDriverWatch({
    timeoutMs: driverTimeoutMs,
    onGone: () => {
      pencilOps({ op: "clear" });
      dropAssertions();
    },
    onChanged: dropAssertions,
  });

  // ── the capability surface (the relay's command set, CDP-delivered) ───────
  // MERGED onto whatever already lives at the global, never assigned over it:
  // the evaluated page bundle (locator · jump · pencil) shares this object —
  // `handle` below reads `mountPencil`/`locateComponents`/`armJump` off it —
  // and a reinstall (relead on hello, a version bump) must not wipe those
  // exports while the bus still thinks the bundle is delivered (found live,
  // 2026-07-17: the two writers clobbering each other took down pencil, area,
  // AND the heartbeat — the claims read "active" over a dead surface).
  w.__aiuiIntentPage = Object.assign((w.__aiuiIntentPage as object | undefined) ?? {}, {
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
      // Each case's return is anchored to the capability's declared reply via
      // `satisfies` (PageCapabilityMap), so tier drift surfaces at compile time.
      // These are type-only annotations — they erase before `buildPageScript`
      // stringifies this bootstrap, so they never reach the injected page.
      switch (capability) {
        case "heartbeat": {
          driverWatch.alive(typeof payload?.session === "string" ? payload.session : "");
          return { ok: true } satisfies PageCapabilityMap["heartbeat"]["reply"];
        }
        case "ring": {
          driverWatch.alive();
          assertRing(
            payload?.on === true,
            payload?.turnTone === true,
            payload?.hollow === true,
            typeof payload?.hint === "string" ? payload.hint : "",
          );
          return { ok: true } satisfies PageCapabilityMap["ring"]["reply"];
        }
        case "flash": {
          flash(String(payload?.kind ?? "shot"));
          return { ok: true } satisfies PageCapabilityMap["flash"]["reply"];
        }
        case "keylayer": {
          driverWatch.alive();
          setKeyCapture(payload?.capture === true);
          return { ok: true } satisfies PageCapabilityMap["keylayer"]["reply"];
        }
        case "selection": {
          const selection = window.getSelection?.();
          const text = selection?.toString() ?? "";
          return (
            text.trim() === ""
              ? null
              : { text, url: location.href, title: document.title, tab: tabRecord?.() }
          ) satisfies PageCapabilityMap["selection"]["reply"];
        }
        case "viewport": {
          // Sampling rides CDP screenshots panel-side, so this tier just acks.
          return { ok: true } satisfies PageCapabilityMap["viewport"]["reply"];
        }
        case "pencil": {
          driverWatch.alive();
          return pencilOps((payload ?? {}) as Record<string, unknown>);
        }
        case "region": {
          driverWatch.alive();
          if ((payload as { arm?: boolean } | undefined)?.arm === true) {
            armRegion();
          } else {
            disarmRegion();
          }
          return { ok: true } satisfies PageCapabilityMap["region"]["reply"];
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
            return { ok: true } satisfies PageCapabilityMap["toolsCall"]["reply"];
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
          return { ok: true } satisfies PageCapabilityMap["toolsCall"]["reply"];
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
              return {
                error: "jump surface not delivered",
              } satisfies PageCapabilityMap["jump"]["reply"];
            }
            // onExit: the page's completion signal — a committed or cancelled pick
            // reports `jumpDone`, and the panel auto-exits the mode (owner,
            // 2026-07-16). `undefined` open keeps jump-mode's default `vscode://`.
            ink.armJump(undefined, () => report({ kind: "jumpDone" }));
          } else {
            ink?.disarmJump?.();
          }
          return { ok: true } satisfies PageCapabilityMap["jump"]["reply"];
        }
        default:
          return { error: `unknown capability: ${capability}` } satisfies CapError;
      }
    },
  });

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
      // `tab: undefined` is dropped by the report's JSON.stringify — safe bare.
      report({ kind: "navigation", from: hereUrl, to, navKind, tab: tabRecord?.() });
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

/** The injectable source. Every self-contained dependency the bootstrap needs
 * rides in as `deps`, stringified (the page fetches nothing): the shared page
 * surfaces, the driver watchdog, and the runtime's `pageTabRecord`. Each source
 * joins the fingerprint, so editing any of them busts the version exactly like
 * editing the bootstrap does. */
export function buildPageScript(): string {
  const bootstrap = pageBootstrap.toString();
  const ring = createRingSurface.toString();
  const flash = createFlash.toString();
  const region = createRegionSurface.toString();
  const pencilOps = createPencilOps.toString();
  const driverWatch = createDriverWatch.toString();
  const tabRecord = pageTabRecord.toString();
  const version = fingerprint(
    bootstrap + ring + flash + region + pencilOps + driverWatch + tabRecord,
  );
  return `(${bootstrap})(${JSON.stringify(version)}, {
    makeRing: (${ring}),
    makeFlash: (${flash}),
    makeRegion: (${region}),
    makePencilOps: (${pencilOps}),
    makeDriverWatch: (${driverWatch}),
    driverTimeoutMs: ${DRIVER_TIMEOUT_MS},
    tabRecord: (${tabRecord}),
  });`;
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
