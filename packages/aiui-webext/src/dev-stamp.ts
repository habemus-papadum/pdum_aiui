/**
 * The dev-artifact stamp: the one fact that makes the CRXJS dev loop
 * *verifiable* instead of merely hopeful.
 *
 * In dev, Vite/CRXJS rewrites the extension's output directory on every server
 * start — loader stubs that import everything from the dev server. Three
 * failure modes follow, and every one of them used to degrade to a blank
 * surface with no error:
 *
 *  1. Chrome reads the directory *while* it is being rewritten → a partial
 *     extension (the panel document loads with no scripts at all).
 *  2. The dev server restarts and the extension is never reloaded → Chrome
 *     keeps serving the artifact of the *previous* run (old code, silently).
 *  3. The dev server isn't running at all → every surface comes up blank.
 *
 * So the dev build writes {@link DEV_STAMP_FILE} into its output directory as
 * the **last** thing it does, and serves the same `runId` at
 * {@link DEV_RUN_ROUTE}. That gives everyone a cheap, honest check:
 *
 *  - **the CLI** (`aiui extension dev` / `aiui extension reload`) waits for the
 *    stamp before telling Chrome to reload — the artifact is complete by
 *    construction (kills 1), and reloads on every dev-server start (kills 2);
 *  - **the extension's own surfaces** (the panel's boot watchdog) compare the
 *    stamp they were loaded with against the one the server is serving now:
 *    unequal → *stale*, unreachable → *server down* (kills 2 and 3 loudly).
 *
 * A production build writes no stamp at all — absence of the file *is* the
 * "this needs no dev server" signal.
 */

/** Written into the dev output directory (never into a production build). */
export const DEV_STAMP_FILE = "aiui-dev.json";

/** Dev-server route serving the current run's {@link DevStamp} (CORS-open). */
export const DEV_RUN_ROUTE = "/@aiui/dev-run";

/** The contents of {@link DEV_STAMP_FILE} — also the {@link DEV_RUN_ROUTE} body. */
export interface DevStamp {
  /** Identifies one dev-server *run*. A restart mints a new one. */
  runId: string;
  /** Where the loader stubs point (`http://localhost:<devPort>`). */
  origin: string;
  /** The pinned dev port, for messages that want to name it. */
  port: number;
  /** ISO timestamp — for humans reading a stale artifact. */
  startedAt: string;
}

/** What an extension surface learned about the dev build it is running. */
export type DevBuildState =
  | { kind: "production" }
  | { kind: "fresh"; stamp: DevStamp }
  | { kind: "stale"; stamp: DevStamp; serving: DevStamp }
  | { kind: "server-down"; stamp: DevStamp };

/**
 * Ask the running extension what shape it is in — from any extension page.
 *
 * Reads its own stamp (`chrome.runtime.getURL`, no permissions needed), then
 * asks the dev server what it is serving. Never throws: a production build
 * (no stamp) reports `production`, an unreachable server reports `server-down`.
 */
export async function checkDevBuild(timeoutMs = 2000): Promise<DevBuildState> {
  const stamp = await fetchJson<DevStamp>(chrome.runtime.getURL(DEV_STAMP_FILE), timeoutMs);
  if (!stamp) {
    return { kind: "production" };
  }
  const serving = await fetchJson<DevStamp>(`${stamp.origin}${DEV_RUN_ROUTE}`, timeoutMs);
  if (!serving) {
    return { kind: "server-down", stamp };
  }
  return serving.runId === stamp.runId
    ? { kind: "fresh", stamp }
    : { kind: "stale", stamp, serving };
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}
