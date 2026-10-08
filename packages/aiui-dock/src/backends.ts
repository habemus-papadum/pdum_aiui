/**
 * backends.ts — the live pane's backend catalogue and what each one needs:
 * a key in the browser (pasted or dev-injected), or the dev server's live
 * routes (`/live/sessions` + the `/live/delegate` relay, which a static site
 * does not have). Pure, except the probe.
 */

export type DockBackendId = "responses-browser" | "hosted" | "responses-server" | "claude";

export interface DockBackend {
  id: DockBackendId;
  label: string;
  where: "browser" | "vendor" | "server";
  blurb: string;
}

export const DOCK_BACKENDS: readonly DockBackend[] = [
  {
    id: "responses-browser",
    label: "responses (browser key)",
    where: "browser",
    blurb: "a Responses model called from this page with the key in this browser",
  },
  {
    id: "hosted",
    label: "hosted responses (vendor)",
    where: "vendor",
    blurb: "the vendor runs the backend; the page registers the app's tools with it",
  },
  {
    id: "responses-server",
    label: "responses (server)",
    where: "server",
    blurb: "the dev server's key, over its relay",
  },
  {
    id: "claude",
    label: "claude code (server)",
    where: "server",
    blurb: "Claude Code behind the dev server's relay — it can read the app's source",
  },
];

export interface BackendAvailability {
  backend: DockBackend;
  enabled: boolean;
  /** Why not, when disabled. */
  why?: string;
}

/** Which backends this page can run, given what it has. */
export function availableBackends(have: { key: boolean; server: boolean }): BackendAvailability[] {
  return DOCK_BACKENDS.map((backend) => {
    if (backend.where === "server") {
      return have.server
        ? { backend, enabled: true }
        : { backend, enabled: false, why: "needs the dev server's live routes" };
    }
    if (!have.key && !(backend.where === "vendor" && have.server)) {
      return { backend, enabled: false, why: "needs an OpenAI key in this browser" };
    }
    return { backend, enabled: true };
  });
}

/**
 * Is the dev server's live backend mounted? Its session route answers a GET
 * with 405 ("POST only"); a plain Vite server has no such route (404, or the
 * SPA fallback, which this request's Accept header declines).
 */
export async function probeServer(
  url = "/live/sessions",
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" } });
    return res.status === 405;
  } catch {
    return false;
  }
}
