import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startStack } from "../infrastructure/stack.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("actual CLI SIGTERM awaits Vite and owned backend/state cleanup", {
  timeout: 40_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dev-stack-cli-test-"));
  // Exercise the adapter's bounded grace period, making the Vite exit race
  // deterministic instead of relying on which ordinary backend closes first.
  const python = join(directory, "slow-python");
  await writeFile(python, '#!/bin/sh\ntrap "" TERM\nexec python3 "$@"\n', { mode: 0o755 });
  const child = spawn(process.execPath, ["dev.mjs", "--port", "0", "--host", "127.0.0.1"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TMPDIR: directory, PYTHON: python },
  });
  const logs = [];
  const stderr = createInterface({ input: child.stderr });
  stderr.on("line", (line) => logs.push(line));
  const stdout = createInterface({ input: child.stdout });
  const ready = Promise.withResolvers();
  stdout.on("line", (line) => {
    logs.push(line);
    try {
      const record = JSON.parse(line);
      if (record.type === "stack-ready") ready.resolve(record);
    } catch {
      /* ordinary CLI output */
    }
  });
  let didExit = false;
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      didExit = true;
      ready.reject(new Error(`CLI exited before readiness (${code}): ${logs.join("\n")}`));
      resolve();
    });
  });
  let record;
  try {
    record = await Promise.race([
      ready.promise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("CLI readiness timed out")), 25_000).unref(),
      ),
    ]);
    assert.equal(record.stateDir.startsWith(directory), true);
    const frontend = record.frontend.local[0];
    assert.equal((await fetch(frontend)).status, 200);
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("CLI shutdown timed out")), 5000).unref(),
      ),
    ]);
    await assert.rejects(access(record.stateDir));
    for (const backend of record.backends)
      assert.throws(() => process.kill(backend.pid, 0), { code: "ESRCH" });
    for (const url of [frontend, ...record.backends.map((backend) => backend.url)])
      await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  } finally {
    if (!didExit) child.kill("SIGKILL");
    await exited.catch(() => undefined);
    for (const backend of record?.backends ?? []) {
      try {
        process.kill(-backend.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") console.error(error);
      }
    }
    stdout.close();
    stderr.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Vite restart preserves backends until final server close", { timeout: 40_000 }, async () => {
  const stack = await startStack({ port: 0, host: "127.0.0.1" });
  try {
    const pids = stack.backends.map(({ pid }) => pid);
    await stack.server.restart();
    for (const [index, backend] of stack.backends.entries()) {
      assert.equal(backend.pid, pids[index]);
      assert.equal((await (await fetch(`${backend.url}info`)).json()).instance, stack.instance);
    }
    const url = stack.server.resolvedUrls.local[0];
    assert.equal((await fetch(`${url}api/python/info`)).status, 200);
    await stack.server.close();
    await assert.rejects(access(stack.stateDir));
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await stack.stop();
  }
});
