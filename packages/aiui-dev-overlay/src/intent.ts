/**
 * The web intent tool: the layer-2 browser widget that collects intent and
 * streams it to a running aiui channel server for prompt lowering.
 *
 * Design decisions (see docs/guide/web-intent-tool in the repo docs):
 *  - **Injected by the Vite plugin, dev-gated structurally.** The
 *    `aiuiDevOverlay()` plugin (this package's `./vite` export) auto-mounts
 *    the tool into every page the dev server serves — `apply: "serve"` means
 *    it cannot exist in a production build. Mounting manually from app code
 *    remains for custom modalities and non-Vite setups. No extension.
 *  - **Stateless.** The widget holds no state beyond the open panel; lowering
 *    state, traces, and debugging all live server-side in the channel process.
 *    Each submission opens a fresh websocket + thread and closes it after.
 *  - **Pluggable modalities.** A modality bundles a UI (`mount`) with the wire
 *    stream format it speaks; the host renders whichever modalities it's given
 *    and hands each a context for opening threads. The bundled
 *    {@link textModality} is the proof-of-concept: a textarea whose submit
 *    exercises the whole pipeline (widget → /ws → lowering → session).
 *  - **Debug affordance.** The 🔍 button opens the lowering-trace debugger in
 *    a new tab: the shared debug-ui viewer the Vite plugin serves at
 *    `/__aiui/debug`, deep-linked to this page's channel session
 *    (`?session=<label>`). Without the plugin the button hides — the channel
 *    serves no HTML; `aiui debug` is the standalone way into the viewer.
 *
 * The channel port arrives at serve time via the `aiuiDevOverlay()` Vite
 * plugin (this package's `./vite` export), which writes it to
 * `window.__AIUI__.port`; pass `port` explicitly outside Vite. Reading
 * `import.meta.env` here cannot work in the shipped package — see vite.ts.
 */
import { addError, dismissError, type OverlayError, type OverlayErrorInput } from "./errors";
import { type ClientMeta, collectClientMeta, setChannelPort } from "./instrumentation";
import { openIntentThread } from "./intent-thread";

export type { IntentThread, OpenThreadOptions } from "./intent-types";

import type { AppSelection, IntentPipelineConfig } from "./intent-pipeline";
import type { IntentThread, OpenThreadOptions } from "./intent-types";
import { multimodalModality } from "./multimodal";
import { installNavigationWatcher, type NavigationChange } from "./navigation";
import { isDevEnvironment } from "./overlay";
import { isErrorMessage, type WebSocketFactory } from "./protocol";
import { installSelectionWatcher, type SelectionSnapshot } from "./selection";
import { mountWidget } from "./ui/widget";

/** Stable id for the injected host element; also the double-injection guard. */
const HOST_ID = "aiui-intent-tool-host";

/** One thread of an intent submission. */
/** What the host provides a mounted modality. */
export interface IntentToolContext {
  /**
   * Open a fresh connection + thread speaking this modality's format.
   * Rejects when no channel port is known or the server is unreachable.
   */
  openThread(options?: OpenThreadOptions): Promise<IntentThread>;
  /** Show a short status line in the panel footer. */
  setStatus(text: string): void;
  /**
   * Surface a failure as a dismissible toast next to the fab — the one
   * error mechanism (see errors.ts). Server-pushed `kind:"error"` messages
   * land here automatically (the host listens on every thread's socket);
   * modalities call it directly for the failures only the client can see
   * (no channel to talk to, a rejected frame, no microphone). Unlike
   * {@link setStatus}, this stays visible with the panel closed — the normal
   * state while driving the multimodal modality — and it dedupes/caps, so
   * repeated identical failures never stack unboundedly.
   */
  reportError(error: OverlayErrorInput): void;
  /** Open the tool's panel. */
  openPanel(): void;
  /** Close the tool's panel. */
  closePanel(): void;
  /** Whether the tool's panel is currently open (for the overlay's own report). */
  panelOpen(): boolean;
  /** The last status line shown in the panel footer (for the overlay's report). */
  lastStatus(): string;
  /** The label of the modality tab currently shown (for the overlay's report). */
  activeModalityLabel(): string;
  /**
   * The on-screen selection currently attached to the panel (the chip), or
   * undefined. A modality reads this at submit time to ride it on the payload.
   */
  selection(): SelectionSnapshot | undefined;
  /** Drop the attached selection — call after a submission consumes it. */
  clearSelection(): void;
  /**
   * Subscribe to selection changes (a new capture, or a clear). The multimodal
   * modality uses this to keep an open turn's `app-selection` event current;
   * returns an unsubscribe.
   */
  onSelectionChange(handler: (snapshot: SelectionSnapshot | undefined) => void): () => void;
  /**
   * Subscribe to same-document navigations (the host's navigation watcher —
   * navigation.ts). The multimodal modality records each as a `navigation`
   * event on an open turn and applies the boundary policy (clear ink on a
   * path change). Handlers run BEFORE the host's own policy (it clears the
   * selection chip on a path change), so a modality sees the pre-navigation
   * selection retract as an ordinary watcher clear, in order. Returns an
   * unsubscribe.
   */
  onNavigation(handler: (change: NavigationChange) => void): () => void;
  /**
   * Exclude a node's selections from capture — for page-level UI a modality
   * mounts outside the tool's shadow host (the multimodal layers: a
   * correct-mode lasso in the transcript preview is a gesture, not an "app
   * selection").
   */
  ignoreSelectionsWithin(node: Node): void;
  /**
   * Claim the widget pill's HUD slot — the always-visible left section of the
   * single anchor (§B.4's merged widget) — for this modality's own content
   * (arm control, state label, level meter). The slot lives in the tool's
   * shadow root, so page-level stylesheets can't reach it: inject the
   * content's CSS through `addStyle`. One claimant per mount; claiming hides
   * the default "✳ aiui" label. `below` is the BELOW-PILL slot: content
   * placed there renders under the pill INSIDE the draggable, bottom-anchored
   * root — so it slides the pill up rather than covering the page, and it
   * follows every drag (the cheat sheet lives there).
   */
  hudSlot(): { container: HTMLElement; below: HTMLElement; addStyle(css: string): void };
  /**
   * Drive the widget's mode ring: the pill's `data-ui-mode` attribute (and
   * so its border color). The modality that owns a mode model calls this
   * with its derived UiMode after every event; undefined clears the ring.
   */
  setUiMode(mode: string | undefined): void;
  /** The channel port in use, if known. */
  readonly port: number | undefined;
}

/** A pluggable intent input: a UI plus the stream format it speaks. */
export interface IntentModality {
  /** The wire stream format this modality speaks (server must know it). */
  format: string;
  /** Label shown on the modality's tab. */
  label: string;
  /** Render the modality's UI into `container`; may return a cleanup handle. */
  mount(container: HTMLElement, ctx: IntentToolContext): undefined | { unmount(): void };
}

export interface IntentToolOptions {
  /**
   * The intent inputs to offer. Defaults to just the bundled multimodal
   * modality — see {@link bundledModalities}. (The text modality remains
   * available by name via `format: "text-concat"` or explicitly here; it
   * left the default set when the widget went multimodal-first.)
   */
  modalities?: IntentModality[];
  /**
   * Pick the bundled modality set by wire-format name: `intent-v1` (the
   * multimodal default), or `text-concat` (text only — the escape hatch). The
   * `aiuiDevOverlay()` Vite plugin's `format` option lands here. Omitted →
   * the multimodal modality alone. Ignored when `modalities` is given;
   * unknown names throw. Custom modalities can't be named this way (they are
   * functions) — pass `modalities` instead.
   */
  format?: string;
  /**
   * Client-side pipeline config for the bundled multimodal modality (talk mode,
   * ink fade, transcriber choice, arming rebind, research knobs). The
   * `aiuiDevOverlay({ intent })` Vite option lands here; JSON-serializable.
   */
  intent?: Partial<IntentPipelineConfig>;
  /**
   * Actor label riding every thread's hello as `meta.actor` — trace
   * provenance. Omitted → `"human"`, unless the tab opted in via the
   * `aiui-actor` sessionStorage toggle (how an agent or CI run labels the tab
   * it drives — see ACTOR_STORAGE_KEY in instrumentation.ts, including why
   * this is an opt-in and not a webdriver heuristic). The channel stamps it on
   * the trace manifest, so agent-driven UI testing is distinguishable from a
   * person in the trace list. Set it explicitly to force a fixed label.
   */
  actor?: string;
  /** Channel port; defaults to the plugin-injected `window.__AIUI__.port`. */
  port?: number | string;
  /**
   * URL of the **trace debugger** the 🔍 opens — the shared debug-ui viewer
   * the `aiuiDevOverlay()` Vite plugin serves at `/__aiui/debug` (the plugin
   * passes this option for you). The link is upgraded to
   * `?session=<label>` once the channel's own session label is known (one
   * fetch of `/debug/api/info`), so the viewer opens pinned to this page's
   * session. Unset (a manual mount, no plugin) → the 🔍 hides: the channel
   * serves no HTML, so there is no page to link (`aiui debug` is the
   * standalone viewer).
   */
  debugUrl?: string;
  /** Mount even outside a dev-like environment (demos, tests). */
  force?: boolean;
  /** Test hook: replaces the global `WebSocket`. */
  webSocketFactory?: WebSocketFactory;
}

/** Handle returned by {@link mountIntentTool}. */
export interface IntentToolHandle {
  open(): void;
  close(): void;
  toggle(): void;
  unmount(): void;
  /** The tool's shadow root, or null for a no-op handle. */
  readonly shadowRoot: ShadowRoot | null;
}

declare global {
  interface Window {
    /** Global guard/handle: one intent tool per page. */
    __aiuiIntentTool?: IntentToolHandle;
  }
}

/**
 * Resolve the channel port: explicit option, else the serve-time
 * `window.__AIUI__.port` injected by the `aiuiDevOverlay()` Vite plugin, else
 * `import.meta.env.VITE_AIUI_PORT`.
 *
 * The env read is a last resort that only works when a bundler compiles this
 * file from *source* (this repo's tests do): the published package is prebuilt,
 * and the library build bakes `import.meta.env` into `dist/` as an empty
 * object, so a consuming app's env can never reach it. That is why the plugin
 * exists — see vite.ts.
 */
function resolvePort(option: number | string | undefined): number | undefined {
  const injected = typeof window === "undefined" ? undefined : window.__AIUI__?.port;
  const env = (import.meta as unknown as { env?: { VITE_AIUI_PORT?: string } }).env?.VITE_AIUI_PORT;
  const port = Number(option ?? injected ?? env);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function noopHandle(): IntentToolHandle {
  return { open() {}, close() {}, toggle() {}, unmount() {}, shadowRoot: null };
}

/**
 * The modalities this package bundles, by the wire format each speaks. Each
 * maker takes the client-side intent config (only the multimodal one uses it).
 */
const BUNDLED_MODALITIES: Record<
  string,
  (intent?: Partial<IntentPipelineConfig>) => IntentModality
> = {
  "intent-v1": (intent) => multimodalModality(intent),
  "text-concat": () => textModality(),
};

/**
 * Resolve the `format` option to the modality set the tool mounts. Omitted →
 * the multimodal modality alone (the Text tab left the default set in the
 * linter pivot; `format: "text-concat"` still mounts it). A named format →
 * that single bundled modality; unknown names throw.
 */
function bundledModalities(
  format: string | undefined,
  intent?: Partial<IntentPipelineConfig>,
): IntentModality[] {
  if (format === undefined) {
    return [multimodalModality(intent)];
  }
  const make = BUNDLED_MODALITIES[format];
  if (!make) {
    const known = Object.keys(BUNDLED_MODALITIES).sort().join(", ");
    throw new Error(
      `unknown intent format "${format}" (bundled formats: ${known}) — pass { modalities } for a custom one`,
    );
  }
  return [make(intent)];
}

/**
 * Mount the intent tool into the current page.
 *
 * No-ops (returns a safe handle) without a DOM, and — unless `force` — outside
 * a dev-like environment. Double-injection safe: a second call returns the
 * existing handle.
 */
export function mountIntentTool(options: IntentToolOptions = {}): IntentToolHandle {
  if (typeof document === "undefined") {
    return noopHandle();
  }
  const existing = window.__aiuiIntentTool;
  if (existing) {
    // A live tool wins; a stale handle — the app rebuilt the DOM out from
    // under us (e.g. `document.body.innerHTML = …` on startup) — is swept so
    // the tool can mount fresh.
    if (existing.shadowRoot?.host.isConnected) {
      return existing;
    }
    existing.unmount();
  }
  if (!options.force && !isDevEnvironment()) {
    return noopHandle();
  }

  const modalities = options.modalities ?? bundledModalities(options.format, options.intent);
  const port = resolvePort(options.port);
  if (port !== undefined) {
    // Publish the port to window.__AIUI__ so the DevTools panel can find the
    // channel server for this page.
    setChannelPort(port);
  }

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadowRoot = host.attachShadow({ mode: "open" });
  document.body.appendChild(host);

  // ── the widget: one Solid-rendered anchor (ui/widget.tsx) ─────────────────
  // Pill (HUD slot + expander) + panel (head/tabs/chip/body/status) + toast
  // column, one draggable unit with the mode ring on the pill. The host owns
  // every piece of state below as plain values and pushes projections into
  // the widget's signals — reads never round-trip through Solid (batched
  // writes read stale same-tick).
  const debugUrl =
    typeof options.debugUrl === "string" && options.debugUrl.length > 0
      ? options.debugUrl
      : undefined;
  // One list, one renderer; everything error-shaped funnels through
  // reportError: server `kind:"error"` pushes (wired per-socket in openThread),
  // the synthetic connection-lost push protocol.ts fabricates, connect
  // failures caught below, and modalities' own client-side failures. The
  // toast column lives beside the pill so it is visible with the panel
  // closed — the normal state while driving the multimodal modality.
  let errors: OverlayError[] = [];
  const widget = mountWidget(shadowRoot, {
    title: "aiui intent",
    // The debug affordance: the lowering-trace debugger — the shared debug-ui
    // viewer the Vite plugin serves (options.debugUrl, normally /__aiui/debug).
    // Without a debugUrl (a manual mount, no plugin) the 🔍 hides: the channel
    // serves no HTML, so there is nothing to link — `aiui debug` is the
    // standalone way in.
    ...(debugUrl !== undefined ? { debugUrl } : {}),
    tabLabels: modalities.map((m) => m.label),
    onTabSelect: (i) => selectTab(i),
    onDismissSelection: () => watcher.clear(),
    onDismissError: (id) => {
      errors = dismissError(errors, id);
      widget.setToasts(errors);
    },
  });
  if (debugUrl !== undefined && port !== undefined && typeof fetch === "function") {
    // Upgrade the 🔍 link with the channel's own session label so the viewer
    // opens pinned to THIS page's session (the label survives in the URL
    // even if the channel later restarts under a new one). Best-effort —
    // the bare route already default-filters to the answering server.
    void fetch(`http://127.0.0.1:${port}/debug/api/info`)
      .then((res) => (res.ok ? (res.json() as Promise<{ session?: string }>) : undefined))
      .then((info) => {
        if (typeof info?.session === "string" && info.session !== "") {
          widget.setDebugHref(`${debugUrl}?session=${encodeURIComponent(info.session)}`);
        }
      })
      .catch(() => {});
  }

  // The last status line is exposed on the context so the overlay's own agent
  // surface can report it (see multimodal/modality.ts).
  let lastStatusText = "";
  const setStatus = (text: string, isError = false): void => {
    lastStatusText = text;
    widget.setStatus(text, isError);
  };
  const reportError = (input: OverlayErrorInput): void => {
    errors = addError(errors, input);
    widget.setToasts(errors);
  };
  // Which modality tab is showing — tracked for the overlay's report.
  let activeIndex = 0;

  // Watch the page's selection so the modality can attach "the thing the user
  // highlighted" to its submission. Ignore selections inside our own host, and
  // re-project the chip whenever the snapshot changes (a new selection or a
  // dismiss); the subscriber set fans the same change out to modalities (the
  // multimodal turn keeps its `app-selection` event current from it).
  const selectionSubscribers = new Set<(snap: SelectionSnapshot | undefined) => void>();
  const projectChip = (snap: SelectionSnapshot | undefined): void => {
    widget.setChip(
      snap === undefined
        ? undefined
        : {
            text: snap.text,
            ...(snap.sourceLoc !== undefined ? { sourceLoc: snap.sourceLoc } : {}),
          },
    );
  };
  const watcher = installSelectionWatcher({
    ignoreWithin: [host],
    onChange: (snap) => {
      projectChip(snap);
      for (const handler of selectionSubscribers) {
        handler(snap);
      }
    },
  });
  projectChip(watcher.snapshot());

  // Watch same-document navigations (an SPA router, a hash jump) so an open
  // turn can record the boundary. Order matters inside the callback: modality
  // handlers first (the `navigation` event lands, then their ink policy), THEN
  // the host's own policy — a path change makes the selection chip stale (its
  // DOM died with the old route), and clearing the watcher both drops the chip
  // and retracts the turn's carried selection via the ordinary onChange path.
  const navigationSubscribers = new Set<(change: NavigationChange) => void>();
  const navWatcher = installNavigationWatcher({
    onNavigate: (change) => {
      for (const handler of navigationSubscribers) {
        handler(change);
      }
      if (change.pathChanged) {
        watcher.clear();
      }
    },
  });

  // One context per modality — openThread speaks that modality's format.
  const contextFor = (modality: IntentModality): IntentToolContext => ({
    port,
    setStatus: (text) => setStatus(text, /fail|error|no channel/i.test(text)),
    reportError,
    openPanel: () => widget.open(),
    closePanel: () => widget.close(),
    panelOpen: () => widget.isOpen(),
    lastStatus: () => lastStatusText,
    activeModalityLabel: () => modalities[activeIndex]?.label ?? "",
    selection: () => watcher.snapshot(),
    clearSelection: () => watcher.clear(),
    onSelectionChange: (handler) => {
      selectionSubscribers.add(handler);
      return () => selectionSubscribers.delete(handler);
    },
    onNavigation: (handler) => {
      navigationSubscribers.add(handler);
      return () => navigationSubscribers.delete(handler);
    },
    ignoreSelectionsWithin: (node) => watcher.addIgnored(node),
    hudSlot: () => widget.claimHudSlot(),
    setUiMode: (mode) => widget.setUiMode(mode),
    async openThread(threadOptions): Promise<IntentThread> {
      if (port === undefined) {
        // The same one-mechanism rule as the connect failure below: toast it
        // here so every modality surfaces "there is no channel" identically.
        const message =
          "no channel port — add the aiuiDevOverlay() Vite plugin and launch with `aiui vite` (or pass { port })";
        reportError({ source: "connection", message });
        throw new Error(message);
      }
      // The hello carries what this page knows about itself — tab identity
      // (extension-stamped), live url/title, source root, the actor label
      // (explicit option, else the tab's opt-in toggle, else "human" — trace
      // provenance), and (intent-v1) the modality's effective config — so the
      // server can contextualize and trace the lowered prompt. Collected fresh
      // per thread.
      const baseMeta = collectClientMeta({ actor: options.actor });
      const meta: ClientMeta | undefined =
        threadOptions?.intent !== undefined
          ? { ...(baseMeta ?? {}), intent: threadOptions.intent }
          : baseMeta;
      try {
        return await openIntentThread({
          url: `ws://127.0.0.1:${port}/ws`,
          format: modality.format,
          ...(meta !== undefined ? { meta } : {}),
          ...(options.webSocketFactory !== undefined
            ? { webSocketFactory: options.webSocketFactory }
            : {}),
          // Route error pushes — server-side failures and the synthetic
          // connection-lost message protocol.ts fabricates — into the toasts.
          // On the raw socket, not the thread wrapper, so connection-level
          // errors (no threadId) and late stragglers are never filtered away.
          onSocket: (socket) => {
            socket.onServerMessage((msg) => {
              if (isErrorMessage(msg)) {
                reportError({
                  message: msg.message,
                  ...(msg.source !== undefined ? { source: msg.source } : {}),
                  ...(msg.detail !== undefined ? { detail: msg.detail } : {}),
                  ...(msg.data !== undefined ? { data: msg.data } : {}),
                });
              }
            });
          },
        });
      } catch (err) {
        // The failure every modality shares: no socket at all (channel down,
        // wrong port, never launched) or a refused hello (an older server that
        // doesn't know the format). Toast it HERE, once, so every modality gets
        // the surfacing for free; the rethrow keeps each modality's own
        // degraded path (compose-locally, status line) exactly as it was.
        reportError({
          source: "connection",
          message: err instanceof Error ? err.message : String(err),
          detail:
            `No channel server answered on 127.0.0.1:${port}. ` +
            "Launch the app through `aiui vite` (with `aiui claude` running), or check the port.",
        });
        throw err;
      }
    },
  });

  // Mount every modality into a vanilla container under the widget's body;
  // tabs switch which container is visible (the tab row itself is
  // widget-rendered — selectTab is its click handler).
  const mounted = modalities.map((modality, i) => {
    const container = document.createElement("div");
    container.hidden = i !== 0;
    widget.body.appendChild(container);
    const cleanup = modality.mount(container, contextFor(modality));
    return { container, cleanup };
  });
  function selectTab(i: number): void {
    activeIndex = i;
    widget.setActiveTab(i);
    mounted.forEach((m, j) => {
      m.container.hidden = j !== i;
    });
  }

  const handle: IntentToolHandle = {
    open: () => widget.open(),
    close: () => widget.close(),
    toggle: () => widget.toggle(),
    unmount() {
      for (const m of mounted) {
        if (m.cleanup && typeof m.cleanup === "object") {
          m.cleanup.unmount();
        }
      }
      widget.dispose();
      watcher.dispose();
      navWatcher.dispose();
      host.remove();
      if (window.__aiuiIntentTool === handle) {
        window.__aiuiIntentTool = undefined;
      }
    },
    shadowRoot,
  };
  window.__aiuiIntentTool = handle;
  console.info(
    port === undefined
      ? "aiui: intent tool mounted — no channel port"
      : `aiui: intent tool mounted — channel port ${port}`,
  );
  return handle;
}

/** Unmount the current intent tool, if any. */
export function unmountIntentTool(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.__aiuiIntentTool?.unmount();
}

/**
 * The wire form of an attached selection: the snapshot minus `at` (a capture
 * timestamp the channel doesn't need). Optional fields are omitted when absent
 * so the payload stays minimal; the channel validates loosely and ignores what
 * it doesn't recognize. Shared with the multimodal modality's end-of-turn
 * `context` chunk so both modalities send selections in one shape.
 */
export function toSelectionPayload(snap: SelectionSnapshot): Record<string, unknown> {
  return {
    text: snap.text,
    rects: snap.rects,
    ...(snap.sourceLoc !== undefined ? { sourceLoc: snap.sourceLoc } : {}),
    ...(snap.cell !== undefined ? { cell: snap.cell } : {}),
    ...(snap.tex !== undefined ? { tex: snap.tex } : {}),
    url: snap.url,
  };
}

/**
 * The event form of an attached selection: the snapshot as the intent
 * pipeline's `AppSelection` payload — no `at` (the event is stamped) and no
 * `rects` (viewport geometry is for screenshot annotation, not the stream).
 * The multimodal modality rides this on the turn's `app-selection` event.
 */
export function toAppSelection(snap: SelectionSnapshot): AppSelection {
  return {
    text: snap.text,
    ...(snap.sourceLoc !== undefined ? { sourceLoc: snap.sourceLoc } : {}),
    ...(snap.cell !== undefined ? { cell: snap.cell } : {}),
    ...(snap.cellLoc !== undefined ? { cellLoc: snap.cellLoc } : {}),
    ...(snap.tex !== undefined ? { tex: snap.tex } : {}),
    ...(snap.url !== "" ? { url: snap.url } : {}),
  };
}

/**
 * The proof-of-concept text modality: a textarea whose submit sends
 * `{ text }` (plus an optional `selection` block when the user highlighted
 * something on the page) as a single-frame `text-concat` thread. No lowering
 * cleverness — it exists to exercise the full data path (widget → websocket →
 * processor → session) and to be the template for real modalities.
 */
export function textModality(): IntentModality {
  return {
    format: "text-concat",
    label: "Text",
    mount(container, ctx) {
      const textarea = document.createElement("textarea");
      textarea.placeholder = "Prompt for the Claude Code session…";

      const row = document.createElement("div");
      row.className = "row";
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = "Enter to send · Shift+Enter for newline";
      const send = document.createElement("button");
      send.type = "button";
      send.className = "send";
      send.textContent = "Send";
      row.append(hint, send);
      container.append(textarea, row);

      const submit = async (): Promise<void> => {
        const text = textarea.value.trim();
        if (!text) {
          return;
        }
        // Attach the current on-screen selection (if any) at submit time; a
        // selection is per-submission, so clear it once the send succeeds.
        const selection = ctx.selection();
        const payload = selection ? { text, selection: toSelectionPayload(selection) } : { text };
        ctx.setStatus("sending…");
        try {
          const thread = await ctx.openThread();
          const ack = await thread.finish(payload);
          if (ack.ok) {
            ctx.setStatus("sent ✓ — check the session (🔍 shows the lowering trace)");
            textarea.value = "";
            ctx.clearSelection();
          } else {
            ctx.setStatus(`send failed: ${ack.error ?? "unknown error"}`);
          }
        } catch (err) {
          ctx.setStatus(err instanceof Error ? err.message : String(err));
        }
      };

      send.addEventListener("click", () => void submit());
      textarea.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          void submit();
        }
      });
      return undefined; // no cleanup beyond the host removing the container
    },
  };
}

// HMR guard: the mounted intent tool holds RUNNING closures from this module,
// and a hot swap would strand them on stale code while fresh modules load
// around them (the silent-stale-tab footgun: pushes flow, the view ignores
// them). Declining makes any edit here a full page reload — mount-once code
// has no meaningful hot path.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // decline() is a NO-OP in Vite 5+ — invalidate-on-accept is the working
    // way to say "this module has no hot path": the update re-propagates as
    // if unaccepted and lands as a full page reload.
    import.meta.hot?.invalidate();
  });
}
