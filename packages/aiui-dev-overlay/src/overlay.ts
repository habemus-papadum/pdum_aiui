/**
 * Dev-only overlay: a Shadow-DOM-isolated "floating tool surface" you import and
 * mount into any page. This is a scaffold — it renders a floating button that
 * toggles a small placeholder panel. The real inspection / element-picking
 * behavior is a TODO (see the sketch in `docs/agentic_ui_workflow`).
 *
 * Dependency-free and browser-only: no Node APIs, no `process`.
 */

/** The published package name — surfaced in the placeholder panel. */
const PACKAGE_NAME = "@habemus-papadum/aiui-dev-overlay";

/** Stable id for the injected host element; also used by the double-injection guard. */
const HOST_ID = "aiui-dev-overlay-host";

/** Options controlling how the overlay mounts. */
export interface DevOverlayOptions {
  /**
   * Mount even when {@link isDevEnvironment} would otherwise decline (e.g. on a
   * production hostname). Useful for demos and tests.
   */
  force?: boolean;
}

/** Handle returned by {@link mountDevOverlay} for controlling the overlay. */
export interface DevOverlayHandle {
  /** Open the placeholder panel. */
  open(): void;
  /** Close the placeholder panel. */
  close(): void;
  /** Toggle the placeholder panel. */
  toggle(): void;
  /** Remove the host element from the DOM and clear the global guard. */
  unmount(): void;
  /** The overlay's shadow root, or `null` for a no-op handle. */
  readonly shadowRoot: ShadowRoot | null;
}

declare global {
  interface Window {
    /** Global guard / handle so a page can only host one overlay at a time. */
    __aiuiDevOverlay?: DevOverlayHandle;
  }
}

/**
 * Heuristic for whether we're in a dev-like environment. Kept deliberately small:
 * - `import.meta.env.DEV` when a Vite consumer bundles us; guarded because
 *   `import.meta.env` is undefined outside Vite.
 * - otherwise a `localhost` / `127.0.0.1` hostname.
 */
export function isDevEnvironment(): boolean {
  const viteDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
  if (viteDev) {
    return true;
  }
  if (typeof location === "undefined") {
    return false;
  }
  const host = location.hostname;
  return host === "localhost" || host === "127.0.0.1";
}

/** A handle that does nothing — returned when we bail out (SSR, or not dev). */
function noopHandle(): DevOverlayHandle {
  return {
    open() {},
    close() {},
    toggle() {},
    unmount() {},
    shadowRoot: null,
  };
}

const STYLES = `
  :host {
    all: initial;
  }
  .aiui-root {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147483647;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    color: #e8e8ea;
  }
  .aiui-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border: none;
    border-radius: 999px;
    background: #1f2430;
    color: #e8e8ea;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
    cursor: pointer;
    user-select: none;
  }
  .aiui-button:hover {
    background: #2a3140;
  }
  .aiui-panel {
    position: absolute;
    right: 0;
    bottom: 44px;
    width: 240px;
    padding: 12px 14px;
    border-radius: 10px;
    background: #1f2430;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  }
  .aiui-panel[hidden] {
    display: none;
  }
  .aiui-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .aiui-panel-title {
    font-weight: 600;
  }
  .aiui-close {
    border: none;
    background: transparent;
    color: #9aa0aa;
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
    padding: 2px 4px;
  }
  .aiui-close:hover {
    color: #e8e8ea;
  }
  .aiui-note {
    color: #9aa0aa;
    margin: 0;
  }
  .aiui-pkg {
    color: #8ab4f8;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    word-break: break-all;
  }
`;

/**
 * Mount the dev overlay into the current page.
 *
 * - No-ops (returns a safe handle) when there is no DOM (SSR).
 * - Dev-gated: without `force`, only mounts in a dev-like environment
 *   (see {@link isDevEnvironment}).
 * - Double-injection safe: if an overlay is already mounted, returns the
 *   existing handle rather than creating a second host.
 */
export function mountDevOverlay(options: DevOverlayOptions = {}): DevOverlayHandle {
  // SSR / no-DOM safety.
  if (typeof document === "undefined") {
    return noopHandle();
  }

  // Double-injection guard: reuse the existing handle if present.
  const existing = window.__aiuiDevOverlay;
  if (existing) {
    return existing;
  }

  // Dev-gating.
  if (!options.force && !isDevEnvironment()) {
    return noopHandle();
  }

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadowRoot = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;
  shadowRoot.appendChild(style);

  const root = document.createElement("div");
  root.className = "aiui-root";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "aiui-button";
  button.textContent = "🛠 aiui";

  const panel = document.createElement("div");
  panel.className = "aiui-panel";
  panel.hidden = true;

  const header = document.createElement("div");
  header.className = "aiui-panel-header";

  const title = document.createElement("span");
  title.className = "aiui-panel-title";
  title.textContent = "aiui dev tool";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "aiui-close";
  closeButton.textContent = "✕";
  closeButton.setAttribute("aria-label", "Close");

  header.appendChild(title);
  header.appendChild(closeButton);

  const pkg = document.createElement("div");
  pkg.className = "aiui-pkg";
  pkg.textContent = PACKAGE_NAME;

  const note = document.createElement("p");
  note.className = "aiui-note";
  // TODO: replace this placeholder with real element picking / inspection UI.
  note.dataset.todo = "element-picking";
  note.textContent = "element picking / inspection: TODO";

  panel.appendChild(header);
  panel.appendChild(pkg);
  panel.appendChild(note);

  root.appendChild(button);
  root.appendChild(panel);
  shadowRoot.appendChild(root);

  document.body.appendChild(host);

  const open = () => {
    panel.hidden = false;
  };
  const close = () => {
    panel.hidden = true;
  };
  const toggle = () => {
    panel.hidden = !panel.hidden;
  };

  button.addEventListener("click", toggle);
  closeButton.addEventListener("click", close);

  const handle: DevOverlayHandle = {
    open,
    close,
    toggle,
    unmount() {
      host.remove();
      if (window.__aiuiDevOverlay === handle) {
        window.__aiuiDevOverlay = undefined;
      }
    },
    shadowRoot,
  };

  window.__aiuiDevOverlay = handle;
  return handle;
}

/**
 * Unmount the currently mounted overlay, if any. Convenience wrapper around the
 * handle's `unmount()` for callers that didn't keep a reference.
 */
export function unmountDevOverlay(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.__aiuiDevOverlay?.unmount();
}
