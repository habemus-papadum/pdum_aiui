import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDevBuild, DEV_RUN_ROUTE, DEV_STAMP_FILE, type DevStamp } from "./dev-stamp";

const stamp: DevStamp = {
  runId: "run-1",
  origin: "http://localhost:5317",
  port: 5317,
  startedAt: "2026-07-12T00:00:00.000Z",
};

/**
 * The extension's own stamp comes from `chrome.runtime.getURL`; the server's
 * comes from the dev-run route. Both are plain fetches — so a fake fetch keyed
 * by URL is the whole harness.
 */
function harness(routes: Record<string, DevStamp | "missing">): void {
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://fake/${path}` },
  });
  vi.stubGlobal("fetch", async (url: string) => {
    const answer = routes[String(url)];
    if (!answer) {
      throw new Error(`connection refused: ${url}`);
    }
    return answer === "missing"
      ? { ok: false, json: async () => ({}) }
      : { ok: true, json: async () => answer };
  });
}

const own = `chrome-extension://fake/${DEV_STAMP_FILE}`;
const serving = `${stamp.origin}${DEV_RUN_ROUTE}`;

describe("checkDevBuild", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports a production build when the extension carries no stamp", async () => {
    harness({ [own]: "missing" });
    expect(await checkDevBuild()).toEqual({ kind: "production" });
  });

  it("reports fresh when the extension's run is the one being served", async () => {
    harness({ [own]: stamp, [serving]: stamp });
    expect(await checkDevBuild()).toEqual({ kind: "fresh", stamp });
  });

  it("reports stale when the server has moved on to another run", async () => {
    const next = { ...stamp, runId: "run-2" };
    harness({ [own]: stamp, [serving]: next });
    expect(await checkDevBuild()).toEqual({ kind: "stale", stamp, serving: next });
  });

  it("reports server-down when the dev server doesn't answer", async () => {
    harness({ [own]: stamp });
    expect(await checkDevBuild()).toEqual({ kind: "server-down", stamp });
  });
});
