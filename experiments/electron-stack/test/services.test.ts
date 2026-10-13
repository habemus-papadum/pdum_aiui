import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startServices } from "../src/shared/services.ts";

test("gateway terminates truncated replies and releases upstream on client disconnect", {
  timeout: 20_000,
}, async () => {
  const state = await mkdtemp(join(tmpdir(), "electron-stream-test-"));
  const disconnected = Promise.withResolvers<void>();
  const worker = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "100" });
    response.write("partial");
    if (request.url === "/truncated") setTimeout(() => response.destroy(), 20);
    else response.once("close", () => disconnected.resolve());
  });
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  let services: Awaited<ReturnType<typeof startServices>> | undefined;
  try {
    const address = worker.address();
    assert.ok(address && typeof address !== "string");
    services = await startServices({
      root: fileURLToPath(new URL("../", import.meta.url)),
      node: process.execPath,
      python: process.env.PYTHON ?? "python3",
      stateDir: state,
      workerUrl: `http://127.0.0.1:${address.port}`,
    });
    const started = Date.now();
    const truncated = await fetch(`${services.url}api/worker/truncated`, {
      signal: AbortSignal.timeout(2000),
    });
    await assert.rejects(truncated.text());
    assert.ok(Date.now() - started < 1500, "Truncated reply must fail before client timeout");
    const streaming = await fetch(`${services.url}api/worker/stream`);
    await streaming.body?.cancel();
    await Promise.race([
      disconnected.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Upstream remained open after client cancellation")),
          2000,
        ).unref(),
      ),
    ]);
  } finally {
    await services?.stop();
    worker.closeAllConnections();
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(state, { recursive: true, force: true });
  }
});

test("a compute backend crash closes its gateway and sibling process", {
  timeout: 30_000,
}, async () => {
  const state = await mkdtemp(join(tmpdir(), "electron-services-test-"));
  const failure = Promise.withResolvers<Error>();
  const services = await startServices({
    root: fileURLToPath(new URL("../", import.meta.url)),
    node: process.execPath,
    python: process.env.PYTHON ?? "python3",
    stateDir: state,
    workerUrl: "https://unused-worker.example.com",
    onFailure: failure.resolve,
  });
  try {
    const python = services.handles.find((backend) => backend.name === "python");
    assert.ok(python);
    process.kill(python.pid, "SIGKILL");
    assert.match((await failure.promise).message, /python exited/);
    await assert.rejects(fetch(`${services.url}api/runtime`));
    for (const backend of services.handles)
      assert.throws(() => process.kill(backend.pid, 0), { code: "ESRCH" });
  } finally {
    await services.stop();
    await rm(state, { recursive: true, force: true });
  }
});
