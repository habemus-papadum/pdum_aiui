import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, utimes } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
interface Ready {
  type: string;
  url: string;
  gateway: string;
  state: string;
  pid: number;
  profile: string;
}
function launch(browserOnly = false) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/dev.ts",
      "--hidden",
      "--mode",
      "desktop",
      ...(browserOnly ? ["--browser-only"] : []),
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
    },
  );
  const events = new EventEmitter();
  const ready: Ready[] = [];
  const log: string[] = [];
  const lines = createInterface({ input: child.stdout });
  const errors = createInterface({ input: child.stderr });
  for (const stream of [lines, errors])
    stream.on("line", (line) => {
      log.push(line);
      try {
        const message = JSON.parse(line);
        if (message.type) ready.push(message);
      } catch {
        /* ordinary tool logs */
      }
      events.emit("update");
    });
  let exited = false;
  const exit = new Promise<void>((resolve) =>
    child.once("exit", () => {
      exited = true;
      resolve();
      events.emit("update");
    }),
  );
  const wait = (predicate: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error(`Dev readiness timeout:\n${log.join("\n")}`)),
        30_000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        events.off("update", check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (predicate()) finish();
        else if (exited) finish(new Error(`Dev exited early:\n${log.join("\n")}`));
      };
      events.on("update", check);
      check();
    });
  return {
    child,
    ready,
    log,
    wait,
    stop: async () => {
      if (!exited) child.kill("SIGTERM");
      await exit;
      lines.close();
      errors.close();
    },
  };
}

async function checkFrontend(url: string) {
  // Exercise the public Vite URL: fetching the private gateway bypasses this proxy.
  const runtime = await fetch(new URL("api/runtime", url));
  assert.equal(runtime.status, 200, `Vite runtime route at ${url}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() =>
      document.querySelector("#runtime")?.textContent?.startsWith("Instance "),
    );
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
      const info = await fetch(new URL(`api/${name}/info?value=a%2Fb`, url));
      assert.equal(info.status, 200);
      const query = (await info.json()).query;
      assert.deepEqual(query.value, name === "python" ? ["a/b"] : "a/b");
      const echo = await page.evaluate(async (name) => {
        const response = await fetch(`./api/${name}/echo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: "vite-renderer" }),
        });
        return { status: response.status, data: await response.json() };
      }, name);
      assert.equal(echo.status, 200);
      assert.deepEqual(echo.data.body, { from: "vite-renderer" });
    }
  } finally {
    await browser.close();
  }
}

test("two hidden dev launches isolate generated output and survive main/preload hot reload", {
  timeout: 120_000,
}, async () => {
  const instances = [launch(), launch()];
  try {
    await Promise.all(
      instances.map((instance) =>
        instance.wait(() => instance.ready.some((message) => message.type === "electron-ready")),
      ),
    );
    const stacks = instances.map((instance) =>
      instance.ready.find((message) => message.type === "stack-ready"),
    );
    const windows = instances.map((instance) =>
      instance.ready.find((message) => message.type === "electron-ready"),
    );
    assert.ok(stacks[0] && stacks[1] && windows[0] && windows[1]);
    assert.notEqual(stacks[0].state, stacks[1].state);
    assert.notEqual(windows[0].profile, windows[1].profile);
    assert.notEqual(windows[0].url, windows[1].url);
    await checkFrontend(windows[0].url);
    assert.equal((await fetch(new URL("api/runtime", windows[1].url))).status, 200);
    const runtimeBefore = await Promise.all(
      stacks.map(async (stack) => (await fetch(`${stack?.gateway}api/runtime`)).json()),
    );
    const main = join(root, "src/main/index.ts");
    await utimes(main, new Date(), new Date());
    await Promise.all(
      instances.map((instance) =>
        instance.wait(
          () => instance.ready.filter((message) => message.type === "electron-ready").length >= 2,
        ),
      ),
    );
    for (const [index, instance] of instances.entries()) {
      const windows = instance.ready.filter((message) => message.type === "electron-ready");
      assert.notEqual(windows[0].pid, windows[1].pid);
      assert.equal(windows[0].url, windows[1].url);
      const runtime = await (await fetch(`${stacks[index]?.gateway}api/runtime`)).json();
      assert.deepEqual(runtime, runtimeBefore[index]);
      assert.equal((await fetch(new URL("api/runtime", windows[index].url))).status, 200);
    }
    const logLengths = instances.map((instance) => instance.log.length);
    await utimes(join(root, "src/preload/index.ts"), new Date(), new Date());
    await Promise.all(
      instances.map((instance, index) =>
        instance.wait(() =>
          instance.log
            .slice(logLengths[index])
            .some((line) => line.includes("reloading electron renderer")),
        ),
      ),
    );
    for (const instance of instances)
      assert.equal(instance.ready.filter((message) => message.type === "electron-ready").length, 2);
    await instances[0].stop();
    await assert.rejects(fetch(`${stacks[0].gateway}api/runtime`));
    await assert.rejects(access(stacks[0].state));
    assert.equal((await fetch(`${stacks[1].gateway}api/runtime`)).status, 200);
    for (const backend of runtimeBefore[0].backends)
      assert.throws(() => process.kill(backend.pid, 0), { code: "ESRCH" });
  } finally {
    await Promise.all(instances.map((instance) => instance.stop()));
  }
});

test("browser-only launch serves working buttons through the same Vite proxy", {
  timeout: 60_000,
}, async () => {
  const instance = launch(true);
  try {
    await instance.wait(() => instance.ready.some((message) => message.type === "browser-ready"));
    const frontend = instance.ready.find((message) => message.type === "browser-ready");
    assert.ok(frontend);
    await checkFrontend(frontend.url);
  } finally {
    await instance.stop();
  }
});

test("interrupting browser startup closes its gateway and removes instance state", {
  timeout: 30_000,
}, async () => {
  const instance = launch(true);
  try {
    await instance.wait(() => instance.ready.some((message) => message.type === "stack-ready"));
    const stack = instance.ready.find((message) => message.type === "stack-ready");
    assert.ok(stack);
    // Signal after backend readiness while the browser-only branch imports/starts Vite.
    await instance.stop();
    await assert.rejects(fetch(`${stack.gateway}api/runtime`));
    await assert.rejects(access(stack.state));
    for (const frontend of instance.ready.filter((message) => message.type === "browser-ready"))
      await assert.rejects(fetch(frontend.url));
  } finally {
    await instance.stop();
  }
});
