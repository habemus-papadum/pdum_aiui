/**
 * The unified intent-tool widget (proposal B2 / interaction handoff §B.4
 * "one widget, not two corners"): ONE draggable anchor hosting what used to
 * be two floating surfaces — the multimodal HUD pill (bottom-left) and the
 * fab + panel + toasts (bottom-right). The pill is always visible
 * (`[hud slot] [expander]`), the panel unfolds above it, the toast column
 * stacks above that, and the mode ring wraps the pill.
 *
 * Solid renders the shell; the HOST (intent.ts) keeps owning the state. The
 * seam is an imperative {@link WidgetHandle}: plain setters write signals,
 * reads come from plain fields (Solid 2 batches writes, so a set-then-get
 * through a signal reads stale — the flag is the truth, the signal is the
 * projection). This keeps the modality contract byte-compatible: modalities
 * still get vanilla containers to mount into (`handle.body`), and the
 * multimodal HUD mounts its existing vanilla content into the pill's slot
 * (`claimHudSlot`) with its styles injected into the shadow root, where page
 * sheets can't reach.
 *
 * Animation doctrine note: nothing here animates from signals. The ring pulse
 * and toast styling are CSS; the meter canvas that lands in the hud slot
 * keeps its own clock (modality-owned interval); signals only flip
 * visibility and class strings.
 */
import { render } from "@solidjs/web";
import { createSignal, For } from "solid-js";
import { makeDraggable } from "../drag";
import type { OverlayError } from "../errors";

/** What the chip row renders — the selection snapshot's display projection. */
export interface WidgetChip {
  text: string;
  sourceLoc?: string;
}

export interface WidgetOptions {
  title: string;
  /** Initial 🔍 href; absent → the button hides (no plugin, no debug page). */
  debugUrl?: string;
  /** The ⧉ Code reader URL; absent → the button hides. */
  codeUrl?: string;
  /** Modality tab labels; fewer than two → the tab row hides. */
  tabLabels: string[];
  onTabSelect(index: number): void;
  onDismissSelection(): void;
  onDismissError(id: number): void;
}

/** The imperative seam intent.ts drives the Solid shell through. */
export interface WidgetHandle {
  /** Parent for the modalities' vanilla containers (Solid never touches its children). */
  readonly body: HTMLElement;
  /**
   * Claim the pill's HUD slot (the multimodal modality's arm/state/meter
   * content). Claiming hides the default "✳ aiui" label. `addStyle` injects
   * the content's CSS into the shadow root. One claimant per mount.
   */
  claimHudSlot(): { container: HTMLElement; addStyle(css: string): void };
  /** Drive the pill's mode ring (`data-ui-mode`); undefined clears it. */
  setUiMode(mode: string | undefined): void;
  setStatus(text: string, error: boolean): void;
  setToasts(list: readonly OverlayError[]): void;
  setChip(chip: WidgetChip | undefined): void;
  /** Upgrade the 🔍 href once the channel's session label is known. */
  setDebugHref(href: string): void;
  setActiveTab(index: number): void;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  dispose(): void;
}

const STYLES = `
  :host { all: initial; }
  .root {
    position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    font-size: 13px; line-height: 1.4; color: #e8e8ea;
  }
  /* The pill: the merged fab + HUD. The mode ring is its border, driven by
     data-ui-mode (one peripheral signal; the pulse is pure CSS). */
  .pill {
    display: inline-flex; align-items: center; gap: 10px; padding: 6px 10px;
    border: 1px solid #262c3a; border-radius: 999px; background: #171b25;
    box-shadow: 0 2px 10px rgba(0,0,0,.35); cursor: grab; user-select: none;
    touch-action: none; color: #9aa0aa;
  }
  .pill[data-ui-mode="ready"], .pill[data-ui-mode="composing"] { border-color: #8ab4f8; }
  .pill[data-ui-mode="talking"] { border-color: #ff5c87;
    animation: ring-pulse 1.2s ease-in-out infinite; }
  .pill[data-ui-mode="shooting"] { border-color: #f8b64c; }
  .pill[data-ui-mode="correcting"] { border-color: #b48af8; }
  /* §B.4: dashed gray = capture released (tweak mode — the page has the
     pointer and keyboard; T or Esc resumes). */
  .pill[data-ui-mode="tweaking"] { border-color: #6b7280; border-style: dashed; }
  @keyframes ring-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(255, 92, 135, 0.45); }
    50% { box-shadow: 0 0 0 5px rgba(255, 92, 135, 0.12); } }
  .hud-slot { display: inline-flex; align-items: center; gap: 10px; }
  .hud-slot:empty { display: none; }
  .pill-label { color: #e8e8ea; white-space: nowrap; }
  .expander {
    border: none; background: transparent; color: #9aa0aa; cursor: pointer;
    font-size: 12px; line-height: 1; padding: 2px 4px;
  }
  .expander:hover { color: #e8e8ea; }
  .panel {
    position: absolute; left: 0; bottom: calc(100% + 8px); width: 320px;
    border-radius: 12px; background: #1f2430;
    box-shadow: 0 6px 24px rgba(0,0,0,.4); overflow: hidden;
  }
  .panel[hidden] { display: none; }
  .head {
    display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px;
    cursor: grab; touch-action: none;
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
  /* The error-toast column: anchored beside the pill (right of the widget,
     mirroring the old left-of-fab layout) so it never covers the panel, which
     unfolds directly above. Bottom-anchored, newest last = nearest the pill.
     Toasts are informational — they steal no focus and block nothing. */
  .toasts {
    position: absolute; left: calc(100% + 8px); bottom: 0;
    width: 300px; max-width: calc(100vw - 96px);
    display: flex; flex-direction: column; gap: 6px;
  }
  .toast {
    border: 1px solid #5c2b31; border-radius: 10px; background: #241b20;
    box-shadow: 0 4px 16px rgba(0,0,0,.35); padding: 8px 10px;
    color: #e8e8ea; font-size: 12px;
  }
  .toast-head { display: flex; align-items: center; gap: 6px; }
  .toast-source {
    color: #f28b82; font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .toast-count {
    color: #9aa0aa; font-size: 10px; border: 1px solid #3a4152;
    border-radius: 999px; padding: 0 6px;
  }
  .toast-dismiss {
    margin-left: auto; border: none; background: transparent; color: #9aa0aa;
    cursor: pointer; font-size: 12px; line-height: 1; padding: 0 2px;
  }
  .toast-dismiss:hover { color: #e8e8ea; }
  .toast-msg { margin-top: 4px; word-break: break-word; }
  .toast-detail { margin-top: 4px; color: #9aa0aa; font-size: 11px; word-break: break-word; }
`;

/**
 * Render the widget into the tool's shadow root and return the imperative
 * handle. All dynamic DOM below is Solid-rendered from signals; the two
 * escape hatches (the modality body, the HUD slot) are refs whose children
 * Solid never manages.
 */
export function mountWidget(shadowRoot: ShadowRoot, options: WidgetOptions): WidgetHandle {
  const style = document.createElement("style");
  style.textContent = STYLES;
  shadowRoot.appendChild(style);

  // The setters live INSIDE the component (Solid 2 signals must be created
  // under the render root or writes never reach the scheduler); the component
  // body runs synchronously during render(), so `api` is populated before
  // mountWidget returns. Plain read-back fields stay out here — the truth the
  // host reads; signals only project (Solid 2 batches writes, so a same-tick
  // signal read-back would be stale).
  interface WidgetApi {
    setOpen(value: boolean): void;
    setStatus(value: { text: string; error: boolean }): void;
    setToasts(value: readonly OverlayError[]): void;
    setChip(value: WidgetChip | undefined): void;
    setMode(value: string | undefined): void;
    setActiveTab(value: number): void;
    setDebugHref(value: string): void;
    setHudClaimed(value: boolean): void;
  }
  let api: WidgetApi | undefined;
  let openFlag = false;

  let bodyEl: HTMLElement | undefined;
  let hudSlotEl: HTMLElement | undefined;
  let rootEl: HTMLElement | undefined;
  let pillEl: HTMLElement | undefined;
  let headEl: HTMLElement | undefined;

  const Widget = () => {
    const [open, setOpen] = createSignal(false);
    const [status, setStatus] = createSignal<{ text: string; error: boolean }>({
      text: "",
      error: false,
    });
    const [toasts, setToasts] = createSignal<readonly OverlayError[]>([]);
    const [chip, setChip] = createSignal<WidgetChip | undefined>(undefined);
    const [mode, setMode] = createSignal<string | undefined>(undefined);
    const [activeTab, setActiveTab] = createSignal(0);
    const [debugHref, setDebugHref] = createSignal(options.debugUrl);
    const [hudClaimed, setHudClaimed] = createSignal(false);
    api = {
      setOpen,
      setStatus,
      setToasts,
      setChip,
      setMode,
      setActiveTab,
      setDebugHref,
      setHudClaimed,
    };
    const setPanelOpen = (value: boolean): void => {
      openFlag = value;
      setOpen(value);
    };
    return (
      <div class="root" ref={(el: HTMLElement) => (rootEl = el)}>
        <div class="toasts">
          <For each={toasts()}>
            {(entry) => (
              <div class="toast">
                <div class="toast-head">
                  <span class="toast-source">{entry.source ?? "error"}</span>
                  {entry.count > 1 && <span class="toast-count">{`×${entry.count}`}</span>}
                  <button
                    type="button"
                    class="toast-dismiss"
                    aria-label="Dismiss error"
                    onClick={() => options.onDismissError(entry.id)}
                  >
                    ✕
                  </button>
                </div>
                <div class="toast-msg">{entry.message}</div>
                {entry.detail !== undefined && <div class="toast-detail">{entry.detail}</div>}
              </div>
            )}
          </For>
        </div>
        <div class="panel" hidden={!open()}>
          <div class="head" ref={(el: HTMLElement) => (headEl = el)}>
            <span class="title">{options.title}</span>
            {options.debugUrl !== undefined && (
              <a
                class="iconbtn"
                href={debugHref()}
                title="Open the lowering debugger"
                target="_blank"
                rel="noreferrer"
              >
                🔍
              </a>
            )}
            {options.codeUrl !== undefined && (
              <a
                class="iconbtn"
                href={options.codeUrl}
                title="Open the code reader (shares this session)"
                target="aiui-code"
                rel="noreferrer"
              >
                ⧉ Code
              </a>
            )}
            <button
              type="button"
              class="iconbtn"
              aria-label="Close"
              onClick={() => setPanelOpen(false)}
            >
              ✕
            </button>
          </div>
          <div class="tabs" hidden={options.tabLabels.length < 2}>
            <For each={options.tabLabels}>
              {(label, i) => (
                <button
                  type="button"
                  class={`tab${activeTab() === i() ? " active" : ""}`}
                  onClick={() => options.onTabSelect(i())}
                >
                  {label}
                </button>
              )}
            </For>
          </div>
          <div class="chiprow" hidden={chip() === undefined}>
            {chip() !== undefined && (
              <div class="chip">
                <span class="chip-label">{`about: "${truncate(chip()?.text ?? "")}"`}</span>
                {chip()?.sourceLoc !== undefined && (
                  <span class="chip-loc">{chip()?.sourceLoc}</span>
                )}
                <button
                  type="button"
                  class="chip-dismiss"
                  aria-label="Dismiss selection"
                  onClick={() => options.onDismissSelection()}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
          <div class="body" ref={(el: HTMLElement) => (bodyEl = el)} />
          <div class={`status${status().error ? " error" : ""}`}>{status().text}</div>
        </div>
        <div class="pill" data-ui-mode={mode()} ref={(el: HTMLElement) => (pillEl = el)}>
          <span class="hud-slot" ref={(el: HTMLElement) => (hudSlotEl = el)} />
          {!hudClaimed() && <span class="pill-label">✳ aiui</span>}
          <button
            type="button"
            class="expander"
            aria-label="Toggle panel"
            onClick={() => setPanelOpen(!openFlag)}
          >
            {open() ? "▾" : "▴"}
          </button>
        </div>
      </div>
    );
  };

  // Render into a wrapper element (render targets an Element; a ShadowRoot
  // is a DocumentFragment) — the wrapper is inert, .root inside it is fixed.
  const mount = document.createElement("div");
  shadowRoot.appendChild(mount);
  const disposeRender = render(Widget, mount);

  // The whole widget moves out of the way by dragging the pill or the panel's
  // header row; a sub-threshold press stays a click (arm ✳, expander, ✕ —
  // see drag.ts). The panel body is not a grip: it holds the modality UI and
  // the textarea, where dragging means selecting.
  const undragPill = rootEl && pillEl ? makeDraggable(rootEl, { handle: pillEl }) : undefined;
  const undragHead = rootEl && headEl ? makeDraggable(rootEl, { handle: headEl }) : undefined;

  if (!bodyEl || !hudSlotEl || !api) {
    throw new Error("widget render did not produce its mount points");
  }
  const body = bodyEl;
  const hudSlot = hudSlotEl;
  const signals = api;
  const setPanel = (value: boolean): void => {
    openFlag = value;
    signals.setOpen(value);
  };

  return {
    body,
    claimHudSlot() {
      signals.setHudClaimed(true);
      return {
        container: hudSlot,
        addStyle(css: string) {
          const extra = document.createElement("style");
          extra.textContent = css;
          shadowRoot.appendChild(extra);
        },
      };
    },
    setUiMode: (value) => signals.setMode(value),
    setStatus: (text, error) => signals.setStatus({ text, error }),
    setToasts: (list) => signals.setToasts([...list]),
    setChip: (value) => signals.setChip(value),
    setDebugHref: (href) => signals.setDebugHref(href),
    setActiveTab: (index) => signals.setActiveTab(index),
    open: () => setPanel(true),
    close: () => setPanel(false),
    toggle: () => setPanel(!openFlag),
    isOpen: () => openFlag,
    dispose() {
      undragPill?.();
      undragHead?.();
      disposeRender();
    },
  };
}

function truncate(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
