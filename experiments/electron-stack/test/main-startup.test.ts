import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import executable from "electron";

const root = fileURLToPath(new URL("../", import.meta.url));

test("terminating Electron during backend startup collects detached compute processes", {
  timeout: 20_000,
}, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "electron-startup-test-"));
  const pids: number[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<void> | undefined;
  try {
    await mkdir(join(fixture, "backends/express"), { recursive: true });
    await writeFile(
      join(fixture, "app-config.json"),
      JSON.stringify({
        mode: "web",
        workerUrl: "https://unused-worker.example.com",
      }),
    );
    await writeFile(
      join(fixture, "backends/express/server.mjs"),
      `
      import { writeFileSync } from 'node:fs';
      import { createServer } from 'node:http';
      writeFileSync(process.env.EXPRESS_PID_FILE, String(process.pid));
      const server = createServer((_req, res) => res.end('{}'));
      server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({
        type: 'dev-ready', url: 'http://127.0.0.1:' + server.address().port + '/'
      })));
    `,
    );
    const python = join(fixture, "delayed-python");
    await writeFile(python, '#!/bin/sh\necho $$ > "$PYTHON_PID_FILE"\nexec sleep 30\n', {
      mode: 0o755,
    });
    child = spawn(executable as unknown as string, [join(root, "out/main/index.cjs")], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "",
        APP_ROOT: fixture,
        APP_HIDDEN: "1",
        APP_MODE: "web",
        APP_PROFILE: join(fixture, "profile"),
        GATEWAY_URL: "",
        NODE_EXECUTABLE: process.execPath,
        PYTHON: python,
        EXPRESS_PID_FILE: join(fixture, "express.pid"),
        PYTHON_PID_FILE: join(fixture, "python.pid"),
      },
    });
    const logs: string[] = [];
    child.stderr?.on("data", (data: Buffer) => logs.push(data.toString()));
    let finished = false;
    exited = new Promise<void>((resolve, reject) => {
      child?.once("error", reject);
      child?.once("exit", () => {
        finished = true;
        resolve();
      });
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const pythonPid = await readFile(join(fixture, "python.pid"), "utf8").catch(() => "");
      if (pythonPid) {
        pids.push(Number(await readFile(join(fixture, "express.pid"), "utf8")), Number(pythonPid));
        break;
      }
      assert.equal(finished, false, `Electron exited before delayed backend: ${logs.join("")}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(pids.length, 2, `Backends did not start: ${logs.join("")}`);
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Shutdown timed out")), 5000).unref(),
      ),
    ]);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    child?.kill("SIGKILL");
    // Reap only fixture-owned groups even when the regression reproduces a leak.
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(error);
      }
    }
    if (exited) await exited.catch(() => undefined);
    await rm(fixture, { recursive: true, force: true });
  }
});
