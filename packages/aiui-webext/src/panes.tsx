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

// Sizes in rem so a host document's root font-size (the browser accessibility
// default × any host zoom) scales the panes; colors read the host's :root
// tokens with the original dark palette as fallbacks, so the kit still renders
// standalone (hairline borders stay px on purpose).
export const PANE_STYLES = `
  .wx-panes { display: flex; flex-direction: column; gap: 0.375rem; }
  .wx-pane {
    border: 1px solid var(--border, #2a3140); border-radius: 8px;
    background: var(--surface, #171b25);
    overflow: hidden;
  }
  .wx-pane-header {
    display: flex; align-items: center; gap: 0.5rem; width: 100%;
    padding: 0.4375rem 0.625rem; border: none; background: transparent;
    color: var(--text, #dfe3ec);
    font: 600 0.75rem ui-sans-serif, system-ui, sans-serif; cursor: pointer;
    text-align: left;
  }
  .wx-pane-header:hover { background: var(--surface-hover, #1d2330); }
  .wx-pane-chevron { transition: transform 120ms; color: var(--muted, #9aa4bd); font-size: 0.625rem; }
  .wx-pane.open > .wx-pane-header .wx-pane-chevron { transform: rotate(90deg); }
  .wx-pane-hint { margin-left: auto; color: var(--muted, #9aa4bd); font-weight: 400; font-size: 0.6875rem; }
  .wx-pane-body { padding: 0.5rem 0.625rem 0.625rem; border-top: 1px solid var(--border-3, #222939); }
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
  /** Observe expand/collapse (e.g. pause polling while collapsed). */
  onToggle?: (open: boolean) => void;
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
        onClick={() => {
          const next = !open();
          setOpen(next);
          props.onToggle?.(next);
        }}
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
