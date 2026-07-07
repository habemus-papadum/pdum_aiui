/**
 * backend-origin.ts — where the reader's *frontend* finds its *backend*.
 *
 * The reader UI runs in the app's page (bundled by the dev overlay) while its
 * backend is a sidecar on the aiui **channel** — a different origin. So every
 * backend call is resolved against the channel origin, computed here:
 *   1. an explicit override ({@link setBackendOrigin}) wins — the standalone dev
 *      harness passes `location.origin`, since it mounts the backend on its own
 *      dev server;
 *   2. else the plugin-injected channel port (`window.__AIUI__.port`) →
 *      `http://127.0.0.1:<port>`;
 *   3. else same-origin (`location.origin`).
 *
 * Kept in the frontend (not the shared protocol) because it reads browser
 * globals; the backend never needs it.
 */

let originOverride: string | undefined;

/** Force the backend origin (the standalone harness passes `location.origin`). */
export function setBackendOrigin(origin: string | undefined): void {
  originOverride = origin;
}

/** The origin the reader's backend (files, LSP, walkthroughs) is served from. */
export function backendOrigin(): string {
  if (originOverride) {
    return originOverride;
  }
  const g = globalThis as { __AIUI__?: { port?: number | string }; location?: { origin: string } };
  const port = g.__AIUI__?.port;
  if (port !== undefined && port !== null && `${port}` !== "") {
    return `http://127.0.0.1:${port}`;
  }
  return g.location?.origin ?? "";
}

/** A backend HTTP URL for a route path (prepends {@link backendOrigin}). */
export function backendUrl(path: string): string {
  return `${backendOrigin()}${path}`;
}
