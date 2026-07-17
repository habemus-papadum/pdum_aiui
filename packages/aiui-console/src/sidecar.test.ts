import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { consoleSidecar } from "./sidecar";

/**
 * Mount the console in PROD mode (static serving from the built `assets/app`)
 * on a throwaway express app. Requires the app bundle to exist — `pnpm -C
 * packages/aiui-console build:app` — which the package build produces; the
 * assertions below say so if it's missing.
 */
async function mount(): Promise<{ base: string; server: Server }> {
  const app = express();
  await consoleSidecar().mount(app, { mode: "prod", log: () => {}, port: () => undefined });
  app.use((_req, res) => res.status(404).end("fell through"));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, server };
}

describe("consoleSidecar (prod)", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("redirects the channel root to the dashboard", async () => {
    let base: string;
    ({ base, server } = await mount());
    const res = await fetch(`${base}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/__aiui/");
  });

  it("serves the dashboard, and the /debug route via the SPA fallback", async () => {
    let base: string;
    ({ base, server } = await mount());

    const home = await fetch(`${base}/__aiui/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toMatch(/text\/html/);

    // The trace-debugger route has no file of its own — the SPA fallback hands
    // it the same shell, and the client router boots the debugger.
    const debug = await fetch(`${base}/__aiui/debug`);
    expect(debug.status).toBe(200);
    expect(debug.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("leaves sibling routes alone (only /, and its own prefix)", async () => {
    let base: string;
    ({ base, server } = await mount());
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("fell through");
  });
});
