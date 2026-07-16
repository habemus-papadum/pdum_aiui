import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { serveClientSurface } from "./web-surface";

/** Mount a prod static surface over a temp dist dir and return its base URL. */
async function mount(distDir: string, prefix = "/x"): Promise<{ url: string; server: Server }> {
  const app = express();
  await serveClientSurface(app, { mode: "prod", prefix, distDir, notBuiltHint: "pnpm build:me" });
  app.use((_req, res) => res.status(404).end("fell through"));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, server };
}

describe("serveClientSurface (prod static)", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("serves index.html at the prefix root and typed assets under it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-surface-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>hi</title>");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app.js"), "export const x = 1");
    ({ server } = await mount(dir));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const root = await fetch(`${base}/x/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toMatch(/text\/html/);
    expect(await root.text()).toContain("<title>hi</title>");

    // The bare prefix (no trailing slash) resolves to index.html too.
    expect((await fetch(`${base}/x`)).status).toBe(200);

    const asset = await fetch(`${base}/x/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
  });

  it("never serves a file outside the bundle root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-surface-"));
    writeFileSync(join(dir, "index.html"), "<h1>ok</h1>");
    // A secret one level ABOVE the served root; a traversal must not reach it.
    writeFileSync(join(dir, "..", "surface-secret.txt"), "TOPSECRET");
    ({ server } = await mount(dir));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // URL normalization collapses `..` before the handler (→ 404 fall-through),
    // and the `startsWith(root)` guard is the backstop for anything that slips
    // past it (→ 403). Either way, the security property holds: no 200, no leak.
    const res = await fetch(`${base}/x/../surface-secret.txt`);
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("TOPSECRET");
  });

  it("answers 503 with the build hint when the bundle is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-surface-")); // empty: never built
    ({ server } = await mount(dir));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const res = await fetch(`${base}/x/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("pnpm build:me");
  });

  it("falls through (not its prefix) so the channel's own routes still win", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-surface-"));
    writeFileSync(join(dir, "index.html"), "<h1>ok</h1>");
    ({ server } = await mount(dir));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("fell through");
  });
});

describe("serveClientSurface (dev vite middleware)", () => {
  let server: Server | undefined;
  let dispose: (() => void | Promise<void>) | undefined;
  afterEach(async () => {
    await dispose?.();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    dispose = undefined;
  });

  // The regression guard for a bug that only shows with SIBLINGS on one app:
  // Vite's middleware stack ends in a terminal 404 (appType mpa/spa) that answers
  // every request it can't serve instead of calling next(). An ungated
  // `app.use(vite.middlewares)` therefore swallows every sidecar mounted after it
  // (live: intent starved /bar and /pencil under the channel). The gate must hand
  // Vite only our-prefix requests and let the rest fall through.
  it("gates on its prefix so a sibling mounted after it still runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "aiui-surface-dev-"));
    writeFileSync(join(root, "index.html"), "<!doctype html><title>dev</title>");
    // Disable Vite's eager pre-transform via an explicit config (which also
    // covers the `viteConfigFile` option pencil uses): against a synthetic root
    // the prefetch only logs benign diagnostics, and it's irrelevant to the gate.
    const configFile = join(root, "vite.config.mjs");
    writeFileSync(configFile, "export default { server: { preTransformRequests: false } };");

    const app = express();
    const surface = await serveClientSurface(app, {
      mode: "dev",
      prefix: "/x",
      viteRoot: root,
      viteConfigFile: configFile,
    });
    dispose = surface.dispose;
    // A sibling sidecar / the channel's own catch-all, mounted AFTER the surface.
    app.use((_req, res) => res.status(404).end("fell through"));
    server = createServer(app);
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    // Vite serves (and HMR-instruments) the transformed entry under our prefix…
    const page = await fetch(`${base}/x/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toContain("@vite/client");

    // …but a NON-prefix request falls through to the sibling — NOT Vite's empty
    // 404. Before the gate, this body was "" (Vite terminated the request).
    const sibling = await fetch(`${base}/health`);
    expect(sibling.status).toBe(404);
    expect(await sibling.text()).toBe("fell through");
  });
});
