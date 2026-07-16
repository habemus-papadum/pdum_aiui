/**
 * The Turn pane's body: the OVERLAY's transcript preview, panel-hosted
 * (Phase C4) — a read-only render of the incremental compiler's accumulator
 * (`composeIntent(events, "replace", { streaming: true })`), with word
 * confidence heat, animated diffs, shot thumbs (hover peek + ✕ → shot-drop)
 * and selection pills. The class subscribes itself to the engine.
 *
 * IMPERATIVE ISLAND, deliberately (Solid 2.0 rule, learned live 2026-07-12):
 * the shared surfaces own internal signals, so building or updating them
 * inside a `createEffect` throws `[REACTIVE_WRITE_IN_OWNED_SCOPE]`. They are
 * built once, outside the reactive graph, and driven by `sync()` from the
 * panel's plain callbacks (phase transitions, engine events).
 *
 * The only host work is geometry: the overlay's `.mm-preview` is a fixed,
 * draggable, centered popup over the page. In the panel it is an ordinary
 * block filling the pane — overridden by MORE SPECIFIC selectors here, never
 * by editing the shared stylesheet.
 */

import { Preview, STYLES } from "@habemus-papadum/aiui-dev-overlay/multimodal-ui";
import type { Engine } from "@habemus-papadum/aiui-lowering-pipeline";

const STYLE_ID = "aiui-panel-preview-styles";

/** The shared multimodal stylesheet + the panel's geometry overrides. */
const PREVIEW_STYLES = `
${STYLES}
/* Panel geometry: an in-flow block, not a floating page popup.
   BORDER-BOX everywhere: the shared rules size by content, so width:100%
   plus their padding/border overflowed the panel and forced a horizontal
   scrollbar at every width (found live 2026-07-12). Long words wrap rather
   than widening the column. */
.preview-host, .preview-host * { box-sizing: border-box; }
.preview-host {
  width: 100%; max-width: 100%; overflow-x: hidden;
}
.preview-host .mm-preview {
  position: static; transform: none; left: auto; bottom: auto;
  width: 100%; max-width: 100%; min-width: 0; z-index: auto;
  display: none; cursor: default; touch-action: auto;
  background: var(--input-bg); border-color: var(--border);
  border-radius: 8px; padding: 0.5rem 0.625rem;
  font: 0.8125rem/1.5 ui-sans-serif, system-ui, sans-serif;
  animation: none;
}
.preview-host .mm-preview.visible {
  display: block; border-color: var(--accent); animation: none;
}
/* Between turns the transcript STAYS (stable geography), just quiet. */
.preview-host .mm-preview { display: block; }
.preview-host .mm-preview:not(.visible) { opacity: 0.55; }
/* Grows with content to ~10 lines, then scrolls. */
.preview-host .mm-preview-body {
  max-height: calc(10 * 1.5em); overflow-y: auto; overflow-x: hidden;
  max-width: 100%; overflow-wrap: anywhere; word-break: break-word;
}
.preview-host .mm-preview-title { color: var(--muted); }
/* Inline shot thumbs keep the shared inline size (the mm-thumb rule's 34px
   height) — a blanket img height:auto blew them up to full width (found live
   2026-07-12). Only cap the width so a thumb can never widen the column. */
.preview-host .mm-thumb { max-width: 100%; }
`;

export interface PreviewIsland {
  /** Mount point for the panel's JSX (a ref callback appends this). */
  readonly root: HTMLElement;
  /** Re-assert visibility from the CURRENT phase. Call from plain callbacks. */
  sync(turnOpen: boolean): void;
}

/** Build the preview island. Call OUTSIDE any effect (see the module doc). */
export function createPreviewIsland(engine: Engine): PreviewIsland {
  if (document.getElementById(STYLE_ID) === null) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = PREVIEW_STYLES;
    document.head.append(style);
  }
  const preview = new Preview(engine);
  const host = document.createElement("div");
  host.className = "preview-host";
  host.append(preview.root);
  return {
    root: host,
    sync(turnOpen) {
      // The overlay's reconciler toggles `.visible` from its uiMode; here the
      // rule is simply "a turn is open" (§13.6 — the accumulator is per-turn).
      preview.root.classList.toggle("visible", turnOpen);
    },
  };
}
