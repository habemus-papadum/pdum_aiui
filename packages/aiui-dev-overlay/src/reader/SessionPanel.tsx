/**
 * SessionPanel.tsx — the reader's window onto the aiui *session bus*.
 *
 * The channel process is one Claude Code session; every browser tab that dials
 * it is a peer. The overlay installs the bus at `window.__AIUI__.session`; this
 * disposable panel makes the reader a second, synchronized view of the session:
 * it mirrors the shared `armed` flag and `preview` (the prompt the app tab is
 * building), and it lets a code selection be *contributed* to that turn.
 *
 * The bus may not exist (no channel → render nothing) or may attach after this
 * component mounts, so we discover it lazily and drive Solid signals from its
 * callbacks. `on()` does not replay an already-landed snapshot, so on wiring we
 * both subscribe AND seed from `get()`/`peers()`. Every subscription is torn
 * down on cleanup (this component is freely hot-swapped).
 */
import type { CodeReader } from "@habemus-papadum/aiui-code";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { SessionBusApi, SessionPeer } from "../session-bus";
import type { PreviewSnapshot, SelectionContribution } from "../session-contrib";
import { SESSION_CONTRIBUTION_TOPIC, SHORT_SELECTION_CHARS } from "../session-contrib";
import {
  excerpt,
  selectionLineCount,
  selectionLoc,
  selectionToContribution,
} from "./reader-contribution";

/** The `preview` slot the app tab publishes as it builds its turn. */
type PreviewState = PreviewSnapshot;

/** Read the bus without depending on the overlay's global type augmentation. */
function locateBus(): SessionBusApi | undefined {
  return (globalThis as unknown as { __AIUI__?: { session?: SessionBusApi } }).__AIUI__?.session;
}

function isPreview(value: unknown): value is PreviewState {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof (value as { text: unknown }).text === "string"
  );
}

export function SessionPanel(props: { reader: CodeReader }) {
  const [bus, setBus] = createSignal<SessionBusApi>();
  const [ready, setReady] = createSignal(false);
  const [armed, setArmed] = createSignal(false);
  const [preview, setPreview] = createSignal<PreviewState>();
  const [peers, setPeers] = createSignal<SessionPeer[]>([]);
  const [sent, setSent] = createSignal(false);
  const [visible, setVisible] = createSignal(false);

  const disposers: Array<() => void> = [];
  let sentTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const wire = (b: SessionBusApi) => {
    if (disposed) return;
    setBus(b);
    // Seed from cache: on() does not replay a snapshot that already landed.
    setReady(b.ready());
    const cachedArmed = b.get("armed");
    if (typeof cachedArmed === "boolean") setArmed(cachedArmed);
    const cachedPreview = b.get("preview");
    if (isPreview(cachedPreview)) setPreview(cachedPreview);
    setPeers(b.peers());
    disposers.push(
      b.on("armed", (v) => {
        if (typeof v === "boolean") setArmed(v);
      }),
      b.on("preview", (v) => {
        if (isPreview(v)) setPreview(v);
      }),
      b.onPeers((p) => setPeers([...p])),
      b.onReady(() => {
        setReady(true);
        setPeers(b.peers());
      }),
    );
  };

  // The bus object is installed by the overlay's mount module; it may not be on
  // the page yet when we render. Poll briefly, then give up (no channel).
  const findBus = (triesLeft: number) => {
    if (disposed) return;
    const b = locateBus();
    if (b) {
      wire(b);
      return;
    }
    if (triesLeft > 0) retryTimer = setTimeout(() => findBus(triesLeft - 1), 100);
  };
  queueMicrotask(() => findBus(50));

  onCleanup(() => {
    disposed = true;
    for (const d of disposers) d();
    if (sentTimer) clearTimeout(sentTimer);
    if (retryTimer) clearTimeout(retryTimer);
  });

  const toggleArmed = () => {
    const b = bus();
    if (!b) return;
    const next = !armed();
    setArmed(next); // optimistic — the hub echoes to other views, not to us
    b.set("armed", next);
  };

  // The reader's live selection, if it has non-empty text to contribute.
  const selection = () => {
    const sel = props.reader.selection();
    if (!sel || sel.text.trim().length === 0) return undefined;
    return {
      loc: selectionLoc(sel),
      lines: selectionLineCount(sel),
      excerpt: excerpt(sel.text),
      short: sel.text.trim().length <= SHORT_SELECTION_CHARS,
    };
  };

  const canContribute = () => !!bus() && armed() && !!selection();

  const contribute = () => {
    const b = bus();
    const sel = props.reader.selection();
    if (!b || !sel || sel.text.trim().length === 0) return;
    b.publish(
      SESSION_CONTRIBUTION_TOPIC,
      selectionToContribution(sel, location.href) satisfies SelectionContribution,
    );
    setSent(true);
    if (sentTimer) clearTimeout(sentTimer);
    sentTimer = setTimeout(() => setSent(false), 1800);
  };

  const appConnected = () => peers().some((p) => p.role === "app");
  const peerLabel = () => {
    if (!ready()) return "connecting…";
    if (appConnected()) return "app tab connected";
    const n = peers().length;
    return n > 0 ? `${n} other view${n === 1 ? "" : "s"}` : "no other views";
  };

  // Trigger the slide-in on the first paint after the panel appears.
  const slideIn = () => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!disposed) setVisible(true);
      }),
    );
  };

  return (
    <Show when={bus()}>
      <div class={visible() ? "session-panel session-panel-in" : "session-panel"} ref={slideIn}>
        <div class="session-panel-head">
          <span class="session-title">session</span>
          <span class="session-peer">
            <span class={appConnected() ? "session-peer-dot on" : "session-peer-dot"} />
            {peerLabel()}
          </span>
        </div>

        <button
          type="button"
          class={armed() ? "session-armed on" : "session-armed"}
          title="Toggle whether the session is listening for a prompt"
          onClick={toggleArmed}
        >
          <span class="lsp-dot" />
          {armed() ? "armed" : "idle"}
        </button>

        <span class="session-section-label">prompt preview</span>
        <Show
          when={preview()?.items?.length || preview()?.text}
          fallback={
            <div class="session-preview session-empty">
              nothing yet — arm and talk in the app tab
            </div>
          }
        >
          {/* Structured mirror (one visual language with the app tab's
              preview): text runs as text, shots and code selections as chips.
              A publisher without `items` (older overlay) falls back to the
              flat text rendering. */}
          <Show
            when={preview()?.items?.length}
            fallback={<div class="session-preview">{preview()?.text}</div>}
          >
            <div class="session-preview">
              <For each={preview()?.items ?? []}>
                {(item) =>
                  item.kind === "text" ? (
                    <span>{`${item.text} `}</span>
                  ) : item.kind === "shot" ? (
                    <span
                      class="session-chip session-chip-shot"
                      title={item.viewport ? "viewport screenshot" : "region screenshot"}
                    >
                      {`⧉ ${item.marker}`}
                    </span>
                  ) : (
                    <span class="session-chip session-chip-code" title={item.excerpt}>
                      {item.sourceLoc ?? "selection"}
                      <span class="session-chip-excerpt">{` ${item.excerpt}`}</span>
                    </span>
                  )
                }
              </For>
            </div>
          </Show>
        </Show>

        <span class="session-section-label">current selection</span>
        <Show
          when={selection()}
          fallback={<div class="session-empty">select code in the reader to contribute</div>}
        >
          {(sel) => (
            <div class="session-sel">
              <span class="session-sel-loc">{sel().loc}</span>
              <span class="session-sel-excerpt">{sel().excerpt}</span>
              <span class="session-sel-hint">
                {sel().lines} line{sel().lines === 1 ? "" : "s"} ·{" "}
                {sel().short ? "inlined" : "added to context"}
              </span>
            </div>
          )}
        </Show>

        <div class="session-actions">
          <button
            type="button"
            class="btn"
            disabled={!canContribute()}
            title={
              armed()
                ? "Contribute this selection to the app tab's prompt"
                : "Arm the session first"
            }
            onClick={contribute}
          >
            Add to prompt →
          </button>
          <Show when={sent()}>
            <span class="session-sent">sent ✓</span>
          </Show>
        </div>
      </div>
    </Show>
  );
}
