import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron } from "@playwright/test";
import executable from "electron";
import { processBackend } from "../../dev-stack/infrastructure/process-backend.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("desktop bridge rejects API documents and navigation guards block redirects", {
  timeout: 30_000,
}, async () => {
  const worker = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "https://untrusted.example.com/" }).end();
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>Backend document</title><p>API HTML</p>");
    }
  });
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  let app: ElectronApplication | undefined;
  try {
    const address = worker.address();
    assert.ok(address && typeof address !== "string");
    app = await electron.launch({
      executablePath: executable as unknown as string,
      args: [join(root, "out/main/index.cjs")],
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "",
        APP_MODE: "desktop",
        APP_HIDDEN: "1",
        APP_ROOT: root,
        NODE_EXECUTABLE: process.execPath,
        WORKER_URL: `http://127.0.0.1:${address.port}`,
      },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.desktopAPI);
    const original = page.url();
    const prevented = await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const navigation = new Promise<boolean>((resolve) => {
        contents.once("will-navigate", (event) => {
          setImmediate(() => resolve(event.defaultPrevented));
        });
      });
      await contents.executeJavaScript("location.href = './api/worker/html'");
      return navigation;
    });
    assert.equal(prevented, true);
    assert.equal(page.url(), original);
    const redirected = await app.evaluate(async ({ BrowserWindow }, target) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      let redirectEvent: Electron.Event | undefined;
      contents.once("will-redirect", (event) => {
        redirectEvent = event;
      });
      try {
        await contents.loadURL(target);
      } catch {
        // Chromium's rejection code varies; the guarded event is the contract.
      }
      return redirectEvent?.defaultPrevented ?? false;
    }, `${original}api/worker/redirect`);
    assert.equal(redirected, true);
    assert.notEqual(new URL(page.url()).hostname, "untrusted.example.com");
    // Main-process loadURL bypasses will-navigate. Sender validation must still
    // reject a backend HTML document even when it has the app's preload script.
    await app.evaluate(async ({ BrowserWindow }, target) => {
      await BrowserWindow.getAllWindows()[0].loadURL(target);
    }, `${original}api/worker/html`);
    await assert.rejects(
      page.evaluate(() => window.desktopAPI?.info()),
      /Untrusted IPC document/,
    );
  } finally {
    await app?.close();
    worker.closeAllConnections();
    await new Promise<void>((resolve) => worker.close(() => resolve()));
  }
});

test("hidden web, desktop and direct-Node modes route to three backends and isolate instances", {
  timeout: 120_000,
}, async () => {
  const state = await mkdtemp(join(tmpdir(), "electron-stack-test-"));
  const worker = await processBackend({
    name: "worker",
    command: process.execPath,
    args: ["backends/worker/dev.mjs"],
    cwd: root,
    env: { DEV_STATE_DIR: state, DEV_INSTANCE_ID: "electron-test-worker" },
    onExit: console.error,
    signal: undefined,
    probePath: "/info",
    timeout: 30_000,
  });
  const applications: ElectronApplication[] = [];
  const urls: string[] = [];
  try {
    for (const mode of ["web", "desktop", "node-direct"]) {
      const app = await electron.launch({
        executablePath: executable as unknown as string,
        args: [join(root, "out/main/index.cjs")],
        cwd: root,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "",
          APP_MODE: mode,
          APP_HIDDEN: "1",
          APP_ROOT: root,
          NODE_EXECUTABLE: process.execPath,
          WORKER_URL: worker.url,
        },
      });
      applications.push(app);
      const page = await app.firstWindow();
      page.on("console", (message) => console.log(`[renderer ${mode}] ${message.text()}`));
      page.on("pageerror", (error) => console.error(`[renderer ${mode}] ${error.message}`));
      page.on("requestfailed", (request) =>
        console.error(`[request ${mode}] ${request.url()} ${request.failure()?.errorText}`),
      );
      console.log(`Testing ${mode} at ${page.url()}`);
      await page.waitForSelector("#runtime");
      await page.waitForFunction(() =>
        document.querySelector("#runtime")?.textContent?.startsWith("Instance "),
      );
      const visible = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => window.isVisible()),
      );
      assert.deepEqual(visible, [false]);
      urls.push(page.url());
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
        const echo = await page.evaluate(
          async (name) =>
            (
              await fetch(`./api/${name}/echo`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ from: "electron" }),
              })
            ).json(),
          name,
        );
        assert.deepEqual(echo.body, { from: "electron" });
      }
      if (mode === "web") {
        assert.equal(await page.evaluate(() => typeof window.desktopAPI), "undefined");
        assert.equal(await page.evaluate(() => typeof window.require), "undefined");
      } else if (mode === "desktop") {
        assert.equal(await page.evaluate(() => typeof window.require), "undefined");
        assert.equal((await page.evaluate(() => window.desktopAPI?.info()))?.mode, "desktop");
        assert.equal(await page.evaluate(() => window.desktopAPI?.setAlwaysOnTop(false)), false);
        assert.equal(await page.evaluate(() => window.desktopAPI?.setAlwaysOnTop(true)), true);
        await assert.rejects(
          page.evaluate(() => window.desktopAPI?.setAlwaysOnTop("yes" as unknown as boolean)),
        );
      } else {
        assert.equal(await page.evaluate(() => typeof window.require), "function");
        assert.match(await page.locator("#node-result").innerText(), /Node reports:/);
      }
    }
    assert.equal(new Set(urls.map((url) => new URL(url).port)).size, 3);
    const ids = await Promise.all(
      applications.map(
        async (app) =>
          (
            await (
              await app.firstWindow()
            ).evaluate(async () => (await fetch("./api/runtime")).json())
          ).instance,
      ),
    );
    assert.equal(new Set(ids).size, 3);
    await applications[0].close();
    applications.shift();
    await assert.rejects(fetch(urls[0]));
    assert.equal((await fetch(urls[1])).status, 200);
  } finally {
    await Promise.all(applications.map((app) => app.close()));
    await worker.stop();
    await rm(state, { recursive: true, force: true });
  }
});
