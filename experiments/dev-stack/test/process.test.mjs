import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processBackend } from "../infrastructure/process-backend.mjs";
import { startStack } from "../infrastructure/stack.mjs";

test("readiness timeout kills the process it started", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dev-stack-test-"));
  const file = join(directory, "pid");
  try {
    await assert.rejects(
      processBackend({
        name: "unready",
        command: process.execPath,
        timeout: 1000,
        args: [
          "-e",
          `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`,
          file,
        ],
      }),
      /readiness timed out/,
    );
    const pid = Number(await readFile(file, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup can be interrupted while a backend is initializing", async () => {
  const controller = new AbortController();
  const pending = processBackend({
    name: "initializing",
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    signal: controller.signal,
  });
  controller.abort(new Error("Startup cancelled"));
  await assert.rejects(pending, /Startup cancelled/);
});

test("a backend crash closes its whole stack", { timeout: 60_000 }, async () => {
  const failure = Promise.withResolvers();
  const stack = await startStack({ port: 0, host: "127.0.0.1", onFailure: failure.resolve });
  try {
    const url = `http://127.0.0.1:${stack.server.httpServer.address().port}/`;
    process.kill(stack.backends.find((backend) => backend.name === "python").pid, "SIGKILL");
    assert.match((await failure.promise).message, /python exited/);
    await assert.rejects(fetch(url));
    for (const backend of stack.backends) await assert.rejects(fetch(backend.url));
  } finally {
    await stack.stop();
  }
});
