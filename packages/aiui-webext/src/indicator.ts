/**
 * The minimal in-page indicator: the only visible thing an aiui extension puts
 * into a page. A small fixed dot (bottom-right, shadow-DOM isolated) plus an
 * optional viewport ring shown while armed — enough to answer "is the tool
 * armed on this tab?" with the side panel closed, and a truthful "tool was
 * armed" marker in captured frames (the indicator, like ink, is page content
 * and so lands in tab captures by design; all other tool chrome lives in the
 * side panel, which tab-scoped captures cannot see).
 *
 * Dependency-free (no Solid): content scripts stay slim.
 */

/** Stable id for the injected host element; also the double-mount guard. */
const HOST_ID = "aiui-webext-indicator-host";

export interface IndicatorState {
  /** Show the armed ring + brighten the dot. */
  armed?: boolean;
  /** Short mode label rendered beside the dot (e.g. "ink"); empty hides it. */
  mode?: string;
  /** Free-form badge text (dev builds show HMR probes here); empty hides it. */
  badge?: string;
}

export interface IndicatorHandle {
  /** Update what the indicator shows. Fields not given are unchanged. */
  set(state: IndicatorState): void;
  /** Register a click handler on the dot (e.g. open/focus the panel). */
  onClick(handler: () => void): () => void;
  /** Remove the indicator from the page. */
  unmount(): void;
}

const STYLES = `
  :host { all: initial; }
  .ring {
    position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;
    /* A soft glow, not a hard border: thicker and fuzzier reads as "live"
       without drawing a line through page content at the edges. */
    box-shadow: inset 0 0 22px 5px rgba(138, 180, 248, 0.4);
    display: none;
  }
  .anchor {
    position: fixed; right: 10px; bottom: 10px; z-index: 2147483647;
    display: inline-flex; align-items: center; gap: 5px;
    font: 11px ui-monospace, monospace; color: #cfd6e4;
    background: rgba(23, 27, 37, 0.85); border: 1px solid #2a3140;
    border-radius: 999px; padding: 3px 7px; cursor: pointer; user-select: none;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #4a5468; transition: background 120ms;
  }
  .armed .dot { background: #8ab4f8; }
  .armed .ring { display: block; }
  .label:empty, .badge:empty { display: none; }
  .badge { color: #9aa4bd; }
`;

/**
 * Mount the indicator into the current page. Double-mount safe: a second call
 * returns a handle to the existing element.
 */
export function mountIndicator(): IndicatorHandle {
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    existing.remove(); // a stale host from a torn-down script: replace wholesale
  }
  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;

  const root = document.createElement("div");
  const ring = document.createElement("div");
  ring.className = "ring";
  const anchor = document.createElement("div");
  anchor.className = "anchor";
  const dot = document.createElement("span");
  dot.className = "dot";
  const label = document.createElement("span");
  label.className = "label";
  const badge = document.createElement("span");
  badge.className = "badge";
  anchor.append(dot, label, badge);
  root.append(ring, anchor);
  shadow.append(style, root);
  document.documentElement.append(host);

  const clickHandlers = new Set<() => void>();
  anchor.addEventListener("click", () => {
    for (const handler of clickHandlers) {
      handler();
    }
  });

  return {
    set(state) {
      if (state.armed !== undefined) {
        root.classList.toggle("armed", state.armed);
      }
      if (state.mode !== undefined) {
        label.textContent = state.mode;
      }
      if (state.badge !== undefined) {
        badge.textContent = state.badge;
      }
    },
    onClick(handler) {
      clickHandlers.add(handler);
      return () => clickHandlers.delete(handler);
    },
    unmount() {
      host.remove();
      clickHandlers.clear();
    },
  };
}
