/**
 * debug-page.ts — the bootstrap the plugin-served trace debugger page runs.
 *
 * The `aiuiDevOverlay()` Vite plugin serves this at `/__aiui/debug` (the intent
 * tool's 🔍 opens it): a full-page {@link TracesPane} — the same shared list +
 * live-followed TraceView the workbench dock and the DevTools extension render —
 * polling the channel's `/debug/api/*` routes cross-origin (the channel opens
 * CORS on `/debug`; it only listens on loopback).
 *
 * URL contract: `?session=<label>` pins the "current session" filter to that
 * label — the 🔍 link passes the label of the channel it talked to, so the page
 * opens on exactly that session's turns even if other sessions share the trace
 * cache (or the channel has since restarted under a new label).
 */
import { TracesPane } from "./traces-pane";

export interface MountDebugPageOptions {
  /** Channel port; defaults to the plugin-injected window.__AIUI__.port. */
  port?: number;
}

/**
 * Boot the trace debugger page: resolve the channel port (option, else the
 * plugin-injected `window.__AIUI__.port`), read the `?session=` pin, and mount
 * a full-viewport {@link TracesPane}. Without a port there is no channel to
 * poll — the page says so instead of rendering an empty list.
 */
export function mountDebugPage(opts: MountDebugPageOptions = {}): void {
  const injected = (globalThis as { window?: { __AIUI__?: { port?: number } } }).window?.__AIUI__
    ?.port;
  const port = opts.port ?? injected;

  const host = document.createElement("div");
  host.style.cssText =
    "position: fixed; inset: 0; display: flex; flex-direction: column; background: #14171f;";
  document.body.style.margin = "0";
  document.body.appendChild(host);

  if (port === undefined) {
    const note = document.createElement("div");
    note.style.cssText =
      "margin: auto; color: #9aa0aa; font: 13px/1.6 ui-sans-serif, system-ui, sans-serif;";
    note.textContent =
      "no channel port — launch the app through `aiui vite` (with `aiui claude` running) so this page knows which channel to poll";
    host.appendChild(note);
    return;
  }

  const session = new URLSearchParams(location.search).get("session") ?? undefined;
  const pane = new TracesPane({
    baseUrl: `http://127.0.0.1:${port}`,
    ...(session !== undefined && session !== "" ? { session } : {}),
  });
  host.appendChild(pane.root);
  pane.activate();
}
