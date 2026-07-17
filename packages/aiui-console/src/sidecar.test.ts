import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { consoleSidecar } from "./sidecar";

/**
 * A stand-in for the built `assets/app` bundle, so PROD static serving is
 * testable without running vite (the REAL artifact is exercised by the package
 * build + e2e). Same pattern as the pencil sidecar's `clientDir` fixture: the
 * content is irrelevant — these assertions test the serving mechanics (index at
 * the prefix, SPA fallback), not the dashboard itself.
 */
let distDir: string;

beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), "console-app-"));
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>aiui console</title>");
});

afterAll(() => rmSync(distDir, { recursive: true, force: true }));

/** Mount the console in PROD mode against the fixture bundle above. */
async function mount(): Promise<{ base: string; server: Server }> {
  const app = express();
  await consoleSidecar({ distDir }).mount(app, {
    mode: "prod",
    log: () => {},
    port: () => undefined,
  });
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
