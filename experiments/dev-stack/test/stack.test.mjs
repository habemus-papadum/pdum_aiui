import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { startStack } from "../infrastructure/stack.mjs";

test("two stacks own independent routes, ports, state and lifecycle", {
  timeout: 120_000,
}, async () => {
  const failures = [];
  const stacks = [];
  try {
    const first = await startStack({
      port: 0,
      host: "127.0.0.1",
      onFailure: (e) => failures.push(e),
    });
    stacks.push(first);
    // Deliberately ask for the already-occupied frontend port: Vite should find another.
    const second = await startStack({
      port: first.server.httpServer.address().port,
      host: "127.0.0.1",
      onFailure: (e) => failures.push(e),
    });
    stacks.push(second);
    const urls = stacks.map(
      (stack) => `http://127.0.0.1:${stack.server.httpServer.address().port}`,
    );
    assert.notEqual(urls[0], urls[1]);
    assert.notEqual(first.stateDir, second.stateDir);
    const ports = stacks.flatMap((stack) => [
      stack.server.httpServer.address().port,
      ...stack.backends.map((backend) => Number(new URL(backend.url).port)),
    ]);
    assert.equal(new Set(ports).size, 6);
    for (const [index, stack] of stacks.entries()) {
      assert.match(await (await fetch(urls[index])).text(), /One site, three backends/);
      for (const name of ["express", "python", "worker"]) {
        const response = await fetch(`${urls[index]}/api/${name}/info?hello=ipad`);
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.backend, name);
        assert.equal(data.instance, stack.instance);
        assert.ok(data.requests >= 1);
        const echo = await fetch(`${urls[index]}/api/${name}/echo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "through the proxy", instance: index }),
        });
        assert.equal(echo.status, 200);
        assert.deepEqual((await echo.json()).body, {
          message: "through the proxy",
          instance: index,
        });
        assert.equal((await fetch(`${urls[index]}/api/${name}/missing`)).status, 404);
      }
    }
    assert.equal(
      (await fetch(`${urls[0]}/api/python-extra/info`)).headers
        .get("content-type")
        ?.includes("application/json"),
      false,
    );
    const internal = first.backends.map((backend) => backend.url);
    await first.stop();
    await assert.rejects(access(first.stateDir));
    for (const url of [urls[0], ...internal]) {
      await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
    }
    const alive = await (await fetch(`${urls[1]}/api/worker/info`)).json();
    assert.equal(alive.instance, second.instance);
    assert.deepEqual(failures, []);
  } finally {
    await Promise.all(stacks.map((stack) => stack.stop()));
  }
});
