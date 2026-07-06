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
 *  - **Debug affordance.** The 🔍 button opens the channel server's `/debug`
 *    viewer — the lowering-trace inspector — in a new tab.
 *
 * The channel port arrives at serve time via the `aiuiDevOverlay()` Vite
 * plugin (this package's `./vite` export), which writes it to
 * `window.__AIUI__.port`; pass `port` explicitly outside Vite. Reading
 * `import.meta.env` here cannot work in the shipped package — see vite.ts.
 */
import { type ClientMeta, collectClientMeta, setChannelPort } from "./instrumentation";
import type { IntentPipelineConfig } from "./intent-pipeline";
import { multimodalModality } from "./multimodal";
import { isDevEnvironment } from "./overlay";
import {
  type Ack,
  type AttachmentChunk,
  type AudioChunk,
  connectIntentSocket,
  type JsonChunk,
  type ServerMessage,
  type WebSocketFactory,
} from "./protocol";
import { installSelectionWatcher, type SelectionSnapshot } from "./selection";

/** Stable id for the injected host element; also the double-injection guard. */
const HOST_ID = "aiui-intent-tool-host";

/** One thread of an intent submission. */
export interface IntentThread {
  /** Send a non-final JSON payload (streaming modalities). */
  send(payload: unknown): Promise<Ack>;
  /** Send the final payload (`fin`) and release the connection. */
  finish(payload?: unknown): Promise<Ack>;
  /**
   * Send a tagged JSON chunk (an `events` batch or the end-of-turn `context`)
   * — the `intent-v1` streaming form. `fin` marks the thread's final frame.
   */
  sendChunk(chunk: JsonChunk, payload: unknown, fin?: boolean): Promise<Ack>;
  /** Send a raw-binary attachment chunk (a shot PNG or a whole audio segment). */
  sendAttachment(chunk: AttachmentChunk, bytes: Uint8Array, fin?: boolean): Promise<Ack>;
  /** Send one streamed PCM frame of a talk segment (the realtime path). */
  sendAudio(chunk: AudioChunk, bytes: Uint8Array, fin?: boolean): Promise<Ack>;
  /** Register a handler for this thread's server pushes (lowered echoes). */
  onServerMessage(handler: (msg: ServerMessage) => void): void;
  /** Close the underlying socket without sending `fin` (a cancel). */
  close(): void;
}

/** Extra per-thread options a modality passes to {@link IntentToolContext.openThread}. */
export interface OpenThreadOptions {
  /**
   * A JSON-serializable client config to ride the hello as `meta.intent` (the
   * `intent-v1` modality's effective `IntentPipelineConfig`), so a lowering
   * trace records the whole configuration.
   */
  intent?: Record<string, unknown>;
}

/** What the host provides a mounted modality. */
export interface IntentToolContext {
  /**
   * Open a fresh connection + thread speaking this modality's format.
   * Rejects when no channel port is known or the server is unreachable.
   */
  openThread(options?: OpenThreadOptions): Promise<IntentThread>;
  /** Show a short status line in the panel footer. */
  setStatus(text: string): void;
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
   * The intent inputs to offer. Defaults to the bundled multimodal modality
   * (active) plus the text modality as an escape hatch — see {@link
   * bundledModalities}.
   */
  modalities?: IntentModality[];
  /**
   * Pick the bundled modality set by wire-format name: `intent-v1` (the
   * multimodal default), or `text-concat` (text only — the escape hatch). The
   * `aiuiDevOverlay()` Vite plugin's `format` option lands here. Omitted →
   * the default set `[multimodal, text]`. Ignored when `modalities` is given;
   * unknown names throw. Custom modalities can't be named this way (they are
   * functions) — pass `modalities` instead.
   */
  format?: string;
  /**
   * Client-side pipeline config for the bundled multimodal modality (talk mode,
   * ink fade, transcriber/corrector choice, arming rebind, research knobs). The
   * `aiuiDevOverlay({ intent })` Vite option lands here; JSON-serializable.
   */
  intent?: Partial<IntentPipelineConfig>;
  /**
   * Actor label riding every thread's hello as `meta.actor` — trace
   * provenance. Omitted → detected at open time: `navigator.webdriver === true`
   * (any browser automation, e.g. the agent driving the session browser via
   * the Chrome DevTools MCP) → `"agent"`, else `"human"`. The channel stamps it
   * on the trace manifest, so agent-driven UI testing is distinguishable from
   * a human in the trace list. Set it explicitly to force a fixed label.
   */
  actor?: string;
  /** Channel port; defaults to the plugin-injected `window.__AIUI__.port`. */
  port?: number | string;
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
 * the default `[multimodal, text]` (multimodal active, text as the escape
 * hatch). A named format → that single bundled modality; unknown names throw.
 */
function bundledModalities(
  format: string | undefined,
  intent?: Partial<IntentPipelineConfig>,
): IntentModality[] {
  if (format === undefined) {
    return [multimodalModality(intent), textModality()];
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

const STYLES = `
  :host { all: initial; }
  .root {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    font-size: 13px; line-height: 1.4; color: #e8e8ea;
  }
  .fab {
    display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px;
    border: none; border-radius: 999px; background: #1f2430; color: #e8e8ea;
    box-shadow: 0 2px 10px rgba(0,0,0,.35); cursor: pointer; user-select: none;
  }
  .fab:hover { background: #2a3140; }
  .panel {
    position: absolute; right: 0; bottom: 44px; width: 320px;
    border-radius: 12px; background: #1f2430;
    box-shadow: 0 6px 24px rgba(0,0,0,.4); overflow: hidden;
  }
  .panel[hidden] { display: none; }
  .head {
    display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px;
  }
  .title { font-weight: 600; margin-right: auto; }
  .iconbtn {
    border: none; background: transparent; color: #9aa0aa; cursor: pointer;
    font-size: 14px; line-height: 1; padding: 2px 4px; text-decoration: none;
  }
  .iconbtn:hover { color: #e8e8ea; }
  .tabs { display: flex; gap: 4px; padding: 0 12px 8px; }
  .tabs[hidden] { display: none; }
  .tab {
    border: none; border-radius: 6px; padding: 3px 10px; cursor: pointer;
    background: transparent; color: #9aa0aa; font-size: 12px;
  }
  .tab:hover { color: #e8e8ea; }
  .tab.active { background: #2a3140; color: #e8e8ea; }
  .chiprow { padding: 0 12px 8px; }
  .chiprow[hidden] { display: none; }
  .chip {
    display: flex; align-items: center; gap: 6px; max-width: 100%;
    border: 1px solid #2a3140; border-radius: 6px; padding: 4px 6px 4px 8px;
    background: #171b24; color: #cfd3da; font-size: 11px;
  }
  .chip-label {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .chip-loc { color: #8ab4f8; flex-shrink: 0; }
  .chip-dismiss {
    margin-left: auto; flex-shrink: 0; border: none; background: transparent;
    color: #9aa0aa; cursor: pointer; font-size: 12px; line-height: 1; padding: 0 2px;
  }
  .chip-dismiss:hover { color: #e8e8ea; }
  .body { padding: 0 12px 10px; }
  .status {
    padding: 6px 12px 10px; color: #9aa0aa; font-size: 11px;
    min-height: 16px; word-break: break-word;
  }
  .status.error { color: #f28b82; }
  textarea {
    width: 100%; box-sizing: border-box; resize: vertical; min-height: 64px;
    border: 1px solid #2a3140; border-radius: 8px; padding: 8px;
    background: #14171f; color: #e8e8ea; font: inherit;
  }
  textarea:focus { outline: 1px solid #8ab4f8; }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .hint { color: #9aa0aa; font-size: 11px; margin-right: auto; }
  .send {
    border: none; border-radius: 8px; padding: 6px 14px; cursor: pointer;
    background: #8ab4f8; color: #14171f; font-weight: 600;
  }
  .send:hover { background: #a5c5fa; }
`;

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
  const style = document.createElement("style");
  style.textContent = STYLES;
  shadowRoot.appendChild(style);

  const root = document.createElement("div");
  root.className = "root";

  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "fab";
  fab.textContent = "✳ aiui";

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.hidden = true;

  const head = document.createElement("div");
  head.className = "head";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = "aiui intent";
  // The debug affordance: the channel server's lowering-trace viewer.
  const debugLink = document.createElement("a");
  debugLink.className = "iconbtn";
  debugLink.textContent = "🔍";
  debugLink.title = "Open the lowering debugger";
  debugLink.target = "_blank";
  debugLink.rel = "noreferrer";
  if (port !== undefined) {
    debugLink.href = `http://127.0.0.1:${port}/debug`;
  } else {
    debugLink.style.display = "none";
  }
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "iconbtn";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Close");
  head.append(title, debugLink, closeBtn);

  const tabs = document.createElement("div");
  tabs.className = "tabs";
  // The selection chip lives above the modality body: "about: '…' · file:line ✕".
  const chipRow = document.createElement("div");
  chipRow.className = "chiprow";
  chipRow.hidden = true;
  const body = document.createElement("div");
  body.className = "body";
  const status = document.createElement("div");
  status.className = "status";

  panel.append(head, tabs, chipRow, body, status);
  root.append(fab, panel);
  shadowRoot.appendChild(root);
  document.body.appendChild(host);

  // The last status line is exposed on the context so the overlay's own agent
  // surface can report it (see multimodal/modality.ts).
  let lastStatusText = "";
  const setStatus = (text: string, isError = false): void => {
    lastStatusText = text;
    status.textContent = text;
    status.className = `status${isError ? " error" : ""}`;
  };
  // Which modality tab is showing — tracked for the overlay's report.
  let activeIndex = 0;

  // Watch the page's selection so the modality can attach "the thing the user
  // highlighted" to its submission. Ignore selections inside our own host, and
  // re-render the chip whenever the snapshot changes (a new selection or a
  // dismiss). `renderChip` is hoisted so `onChange` can name it here.
  const watcher = installSelectionWatcher({
    ignoreWithin: [host],
    onChange: (snap) => renderChip(snap),
  });

  function renderChip(snap: SelectionSnapshot | undefined): void {
    chipRow.replaceChildren();
    chipRow.hidden = snap === undefined;
    if (snap === undefined) {
      return;
    }
    const chip = document.createElement("div");
    chip.className = "chip";

    const label = document.createElement("span");
    label.className = "chip-label";
    const trimmed = snap.text.length > 40 ? `${snap.text.slice(0, 40)}…` : snap.text;
    label.textContent = `about: "${trimmed}"`;
    chip.appendChild(label);

    if (snap.sourceLoc !== undefined) {
      const loc = document.createElement("span");
      loc.className = "chip-loc";
      loc.textContent = snap.sourceLoc;
      chip.appendChild(loc);
    }

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "chip-dismiss";
    dismiss.textContent = "✕";
    dismiss.setAttribute("aria-label", "Dismiss selection");
    dismiss.addEventListener("click", () => watcher.clear());
    chip.appendChild(dismiss);

    chipRow.appendChild(chip);
  }
  renderChip(watcher.snapshot());

  // One context per modality — openThread speaks that modality's format.
  const contextFor = (modality: IntentModality): IntentToolContext => ({
    port,
    setStatus: (text) => setStatus(text, /fail|error|no channel/i.test(text)),
    openPanel: () => {
      panel.hidden = false;
    },
    closePanel: () => {
      panel.hidden = true;
    },
    panelOpen: () => !panel.hidden,
    lastStatus: () => lastStatusText,
    activeModalityLabel: () => modalities[activeIndex]?.label ?? "",
    selection: () => watcher.snapshot(),
    clearSelection: () => watcher.clear(),
    async openThread(threadOptions): Promise<IntentThread> {
      if (port === undefined) {
        throw new Error(
          "no channel port — add the aiuiDevOverlay() Vite plugin and launch with `aiui vite` (or pass { port })",
        );
      }
      // The hello carries what this page knows about itself — tab identity
      // (extension-stamped), live url/title, source root, the actor label
      // (explicit option, else webdriver-detected — trace provenance), and
      // (intent-v1) the modality's effective config — so the server can
      // contextualize and trace the lowered prompt. Collected fresh per thread.
      const baseMeta = collectClientMeta({ actor: options.actor });
      const meta: ClientMeta | undefined =
        threadOptions?.intent !== undefined
          ? { ...(baseMeta ?? {}), intent: threadOptions.intent }
          : baseMeta;
      const socket = await connectIntentSocket(
        `ws://127.0.0.1:${port}/ws`,
        modality.format,
        options.webSocketFactory,
        meta,
      );
      const threadId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return {
        send: (payload) => socket.send(threadId, payload, false),
        finish: async (payload) => {
          const ack = await socket.send(threadId, payload, true);
          socket.close();
          return ack;
        },
        sendChunk: (chunk, payload, fin = false) => socket.sendChunk(threadId, chunk, payload, fin),
        sendAttachment: (chunk, bytes, fin = false) =>
          socket.sendAttachment(threadId, chunk, bytes, fin),
        sendAudio: (chunk, bytes, fin = false) => socket.sendAudio(threadId, chunk, bytes, fin),
        onServerMessage: (handler) =>
          socket.onServerMessage((msg) => {
            // Route only this thread's pushes (server may omit threadId for
            // connection-level notices — deliver those too).
            if (msg.threadId === undefined || msg.threadId === threadId) {
              handler(msg);
            }
          }),
        close: () => socket.close(),
      };
    },
  });

  // Mount every modality; tabs switch which container is visible.
  const mounted = modalities.map((modality, i) => {
    const container = document.createElement("div");
    container.hidden = i !== 0;
    body.appendChild(container);
    const cleanup = modality.mount(container, contextFor(modality));

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `tab${i === 0 ? " active" : ""}`;
    tab.textContent = modality.label;
    tab.addEventListener("click", () => {
      activeIndex = i;
      mounted.forEach((m, j) => {
        m.container.hidden = j !== i;
        m.tab.classList.toggle("active", j === i);
      });
    });
    tabs.appendChild(tab);
    return { container, tab, cleanup };
  });
  if (modalities.length < 2) {
    tabs.hidden = true;
  }

  const open = (): void => {
    panel.hidden = false;
  };
  const close = (): void => {
    panel.hidden = true;
  };
  fab.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
  });
  closeBtn.addEventListener("click", close);

  const handle: IntentToolHandle = {
    open,
    close,
    toggle: () => {
      panel.hidden = !panel.hidden;
    },
    unmount() {
      for (const m of mounted) {
        if (m.cleanup && typeof m.cleanup === "object") {
          m.cleanup.unmount();
        }
      }
      watcher.dispose();
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
