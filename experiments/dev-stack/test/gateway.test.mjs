import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import assetsWorker from "../deploy/assets-worker.mjs";
import { routeApi } from "../deploy/gateway.mjs";
import r2Worker from "../deploy/r2-worker.mjs";

test("production API gateway preserves method, body, query and base path", async () => {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        path: request.url,
        method: request.method,
        body: Buffer.concat(chunks).toString(),
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}/service`;
    for (const name of ["express", "python", "worker"]) {
      const request = new Request(`https://site.example/api/${name}/echo?x=1`, {
        method: "POST",
        body: "hello",
        headers: { "Content-Type": "text/plain" },
      });
      const response = await routeApi(request, { [`${name.toUpperCase()}_ORIGIN`]: origin });
      assert.deepEqual(await response.json(), {
        path: "/service/echo?x=1",
        method: "POST",
        body: "hello",
      });
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
    assert.equal((await routeApi(new Request("https://site.example/api/nope"), {})).status, 404);
    assert.equal(
      (await routeApi(new Request("https://site.example/api/python/info"), {})).status,
      503,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("assets gateway delegates static content while keeping API failures JSON", async () => {
  const env = { ASSETS: { fetch: () => new Response("static HTML") } };
  assert.equal(
    await (await assetsWorker.fetch(new Request("https://site.example/"), env)).text(),
    "static HTML",
  );
  const response = await assetsWorker.fetch(
    new Request("https://site.example/api/python/info"),
    env,
  );
  assert.equal(response.status, 503);
  assert.match(response.headers.get("Content-Type"), /application\/json/);
});

test("R2 gateway maps keys, retains metadata, supports HEAD and revalidation", async () => {
  const keys = [];
  const env = {
    STATIC_PREFIX: "release-1",
    SITE: {
      get: async (key) => {
        keys.push(key);
        if (!key.endsWith("index.html")) return null;
        return {
          body: "<h1>Hello</h1>",
          size: 14,
          httpEtag: '"abc"',
          writeHttpMetadata: (headers) => headers.set("Content-Type", "text/html"),
        };
      },
    },
  };
  const response = await r2Worker.fetch(new Request("https://site.example/"), env);
  assert.equal(await response.text(), "<h1>Hello</h1>");
  assert.equal(response.headers.get("ETag"), '"abc"');
  assert.deepEqual(keys, ["release-1/index.html"]);
  const head = await r2Worker.fetch(new Request("https://site.example/", { method: "HEAD" }), env);
  assert.equal(await head.text(), "");
  const cached = await r2Worker.fetch(
    new Request("https://site.example/", { headers: { "If-None-Match": '"abc"' } }),
    env,
  );
  assert.equal(cached.status, 304);
  assert.equal(
    (await r2Worker.fetch(new Request("https://site.example/missing.js"), env)).status,
    404,
  );
  assert.equal(
    (await r2Worker.fetch(new Request("https://site.example/api/nope"), env)).status,
    404,
  );
  assert.equal((await r2Worker.fetch(new Request("https://site.example/%zz"), env)).status, 400);
});
