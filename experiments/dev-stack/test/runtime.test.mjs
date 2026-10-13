import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { createApp } from "../backends/express/app.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("both deployment gateways run in workerd with real assets/R2 and an HTTP backend", {
  timeout: 30_000,
}, async () => {
  const server = createApp("gateway-runtime-test").listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const bindings = {
    EXPRESS_ORIGIN: `http://127.0.0.1:${server.address().port}/`,
    STATIC_PREFIX: "release-1",
  };
  const runtimes = [];
  try {
    const assets = new Miniflare(
      convertV4MiniflareOptions({
        modulesRoot: `${root}deploy`,
        modules: [
          { type: "ESModule", path: `${root}deploy/assets-worker.mjs` },
          { type: "ESModule", path: `${root}deploy/gateway.mjs` },
        ],
        compatibilityDate: "2026-10-13",
        bindings,
        assets: {
          directory: `${root}app`,
          binding: "ASSETS",
          run_worker_first: true,
          routerConfig: { has_user_worker: true },
        },
      }),
    );
    runtimes.push(assets);
    const r2 = new Miniflare(
      convertV4MiniflareOptions({
        modulesRoot: `${root}deploy`,
        modules: [
          { type: "ESModule", path: `${root}deploy/r2-worker.mjs` },
          { type: "ESModule", path: `${root}deploy/gateway.mjs` },
        ],
        compatibilityDate: "2026-10-13",
        bindings,
        r2Buckets: ["SITE"],
      }),
    );
    runtimes.push(r2);
    const bucket = await r2.getR2Bucket("SITE");
    await bucket.put("release-1/index.html", "<h1>R2 static site</h1>", {
      httpMetadata: { contentType: "text/html" },
    });
    assert.match(
      await (await assets.dispatchFetch("https://site.example/")).text(),
      /One site, three backends/,
    );
    assert.match(await (await r2.dispatchFetch("https://site.example/")).text(), /R2 static site/);
    for (const worker of [assets, r2]) {
      const response = await worker.dispatchFetch(
        "https://site.example/api/express/info?from=gateway",
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).instance, "gateway-runtime-test");
      const echo = await worker.dispatchFetch("https://site.example/api/express/echo", {
        method: "POST",
        body: JSON.stringify({ source: "workerd" }),
        headers: { "Content-Type": "application/json" },
      });
      assert.deepEqual((await echo.json()).body, { source: "workerd" });
      assert.equal((await worker.dispatchFetch("https://site.example/api/unknown")).status, 404);
      assert.equal((await worker.dispatchFetch("https://site.example/missing.js")).status, 404);
    }
  } finally {
    try {
      await Promise.all(runtimes.map((runtime) => runtime.dispose()));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
