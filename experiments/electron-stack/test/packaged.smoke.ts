import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ElectronApplication, _electron as electron } from "@playwright/test";
import { processBackend } from "../../dev-stack/infrastructure/process-backend.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const executable =
  process.env.PACKAGED_EXECUTABLE ??
  (process.platform === "darwin"
    ? join(
        root,
        `artifacts/mac-${process.arch}`,
        "Electron Stack Spike.app/Contents/MacOS/Electron Stack Spike",
      )
    : join(root, "artifacts/linux-unpacked/electron-stack-spike"));

test("packaged app uses its own Python/Node with no system PATH and proxies a remote Worker", {
  timeout: 90_000,
}, async () => {
  const state = await mkdtemp(join(tmpdir(), "electron-packaged-test-"));
  const worker = await processBackend({
    name: "remote-worker-fixture",
    command: process.execPath,
    args: ["backends/worker/dev.mjs"],
    cwd: root,
    env: { DEV_STATE_DIR: state, DEV_INSTANCE_ID: "remote-worker-fixture" },
    onExit: console.error,
    signal: undefined,
    probePath: "/info",
    timeout: 30_000,
  });
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: executable,
      cwd: tmpdir(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "",
        APP_MODE: "desktop",
        APP_HIDDEN: "1",
        APP_ROOT: "",
        GATEWAY_URL: "",
        ELECTRON_RENDERER_URL: "",
        NODE_EXECUTABLE: "",
        PYTHON: "",
        PATH: "/nonexistent",
        WORKER_URL: worker.url,
      },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() =>
      document.querySelector("#runtime")?.textContent?.startsWith("Instance "),
    );
    const runtime = await page.evaluate(async () => (await fetch("./api/runtime")).json());
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    for (const name of ["express", "python", "worker"]) {
      await page.locator(`[data-backend=${name}]`).click();
      await page.waitForFunction(
        (name) =>
          document
            .querySelector(`[data-backend=${name}]`)
            ?.parentElement?.querySelector("pre")
            ?.textContent?.includes(`"backend": "${name}"`),
        name,
      );
    }
    for (const backend of runtime.backends) {
      const { stdout } = await promisify(execFile)("/bin/ps", [
        "-p",
        String(backend.pid),
        "-o",
        "command=",
      ]);
      assert.match(
        stdout,
        new RegExp(
          `runtimes/${backend.name === "express" ? "node/bin/node" : "python/bin/python"}`,
        ),
      );
    }
    const ports = new URL(page.url()).port;
    assert.equal((await fetch(`http://127.0.0.1:${ports}/`)).status, 404);
    const url = page.url();
    await app.close();
    app = undefined;
    await assert.rejects(fetch(url));
    for (const backend of runtime.backends)
      assert.throws(() => process.kill(backend.pid, 0), { code: "ESRCH" });
  } finally {
    await app?.close();
    await worker.stop();
    await rm(state, { recursive: true, force: true });
  }
});
