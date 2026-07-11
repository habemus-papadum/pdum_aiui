/**
 * Collapsible-pane primitives for extension side panels — the panel-first UI's
 * basic layout unit (browser-extension-intent-tool.md: the panel is a vertical
 * stack of collapsible sections; several may be open at once).
 *
 * Pane children stay MOUNTED while collapsed (`hidden`, not unmounted): panes
 * hold live things — sockets, transcripts, an embedded trace viewer — and
 * collapsing must never reset them. A pane that wants lazy work should key it
 * off its own visibility instead.
 *
 * Styling is a plain stylesheet injected once per document
 * ({@link injectPaneStyles}); the panel is an extension page we own, so no
 * shadow-DOM ceremony is needed.
 */
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";

const STYLE_ID = "aiui-webext-pane-styles";

export const PANE_STYLES = `
  .wx-panes { display: flex; flex-direction: column; gap: 6px; }
  .wx-pane {
    border: 1px solid #2a3140; border-radius: 8px; background: #171b25;
    overflow: hidden;
  }
  .wx-pane-header {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 7px 10px; border: none; background: transparent; color: #dfe3ec;
    font: 600 12px ui-sans-serif, system-ui, sans-serif; cursor: pointer;
    text-align: left;
  }
  .wx-pane-header:hover { background: #1d2330; }
  .wx-pane-chevron { transition: transform 120ms; color: #9aa4bd; font-size: 10px; }
  .wx-pane.open > .wx-pane-header .wx-pane-chevron { transform: rotate(90deg); }
  .wx-pane-hint { margin-left: auto; color: #9aa4bd; font-weight: 400; font-size: 11px; }
  .wx-pane-body { padding: 8px 10px 10px; border-top: 1px solid #222939; }
`;

/** Inject the pane stylesheet once into `doc` (idempotent by element id). */
export function injectPaneStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PANE_STYLES;
  doc.head.append(style);
}

/** The vertical stack that hosts {@link Pane}s. */
export function PaneStack(props: { children: JSX.Element }): JSX.Element {
  return <div class="wx-panes">{props.children}</div>;
}

export interface PaneProps {
  title: string;
  /** Start expanded (default true). */
  defaultOpen?: boolean;
  /** Optional right-aligned hint text in the header (a count, a status). */
  hint?: string;
  children: JSX.Element;
}

/** One collapsible section. Children stay mounted while collapsed. */
export function Pane(props: PaneProps): JSX.Element {
  const [open, setOpen] = createSignal(props.defaultOpen ?? true);
  return (
    <section class={open() ? "wx-pane open" : "wx-pane"}>
      <button
        type="button"
        class="wx-pane-header"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen((v) => !v)}
      >
        <span class="wx-pane-chevron">▶</span>
        <span>{props.title}</span>
        <Show when={props.hint !== undefined}>
          <span class="wx-pane-hint">{props.hint}</span>
        </Show>
      </button>
      <div class="wx-pane-body" hidden={!open()}>
        {props.children}
      </div>
    </section>
  );
}
