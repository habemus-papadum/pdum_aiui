import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { processBackend } from "../../dev-stack/infrastructure/process-backend.mjs";
import { gatewayProxy } from "../infrastructure/gateway-proxy.ts";
import { startServices } from "../src/shared/services.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "web" },
    hidden: { type: "boolean", default: false },
    "worker-url": { type: "string" },
    "browser-only": { type: "boolean", default: false },
  },
});
if (!["web", "desktop", "node-direct"].includes(values.mode))
  throw new Error("Use --mode web, desktop, or node-direct");
const state = await mkdtemp(join(tmpdir(), "electron-stack-dev-"));
let worker: Awaited<ReturnType<typeof processBackend>> | undefined;
let services: Awaited<ReturnType<typeof startServices>> | undefined;
let child: ReturnType<typeof spawn> | undefined;
let webServer: Awaited<ReturnType<typeof import("vite").createServer>> | undefined;
let webListener: ReturnType<typeof createHttpServer> | undefined;
let pendingWebStartup: Promise<void> | undefined;
let stopping = false;
let status = 0;
const startup = new AbortController();
let stopPromise: Promise<void> | undefined;
const stop = () => {
  stopPromise ??= (async () => {
    stopping = true;
    startup.abort();
    if (child?.pid) {
      // SIGTERM lets the main process close its resources before the entire group is reaped.
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const pid = child.pid;
      const launched = child;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        new Promise<void>((resolve) => launched.once("exit", () => resolve())),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
      clearTimeout(timer);
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await pendingWebStartup?.catch(() => undefined);
    await webServer?.close();
    if (webListener) {
      webListener.closeAllConnections();
      await new Promise<void>((resolve) => webListener?.close(() => resolve()));
    }
    await services?.stop();
    await worker?.stop();
    await rm(state, { recursive: true, force: true });
    process.exitCode = status;
  })();
  return stopPromise;
};
const fail = (error: Error) => {
  if (stopping) return;
  console.error(error);
  status = 1;
  void stop();
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void stop();
  });
try {
  let workerUrl = values["worker-url"];
  if (!workerUrl) {
    worker = await processBackend({
      name: "worker",
      command: process.execPath,
      args: ["backends/worker/dev.mjs"],
      cwd: root,
      env: { DEV_INSTANCE_ID: `local-${Date.now()}-${process.pid}`, DEV_STATE_DIR: state },
      onExit: fail,
      signal: startup.signal,
      probePath: "/info",
      timeout: 30_000,
    });
    workerUrl = worker.url;
  }
  if (stopping) {
    await worker?.stop();
    await rm(state, { recursive: true, force: true });
  } else {
    if (!workerUrl) throw new Error("Missing Worker URL");
    services = await startServices({
      root,
      node: process.execPath,
      python: process.env.PYTHON ?? "python3",
      stateDir: state,
      workerUrl,
      signal: startup.signal,
      onFailure: fail,
    });
    if (stopping) {
      await services.stop();
    } else {
      console.log(
        JSON.stringify({
          type: "stack-ready",
          instance: services.instance,
          gateway: services.url,
          state,
          pid: process.pid,
        }),
      );
      if (values["browser-only"]) {
        const gateway = services.url;
        pendingWebStartup = (async () => {
          const { createServer } = await import("vite");
          startup.signal.throwIfAborted();
          const listener = createHttpServer();
          webListener = listener;
          webServer = await createServer({
            configFile: false,
            root: join(root, "src/renderer"),
            cacheDir: join(state, "vite-browser"),
            server: {
              host: "127.0.0.1",
              // Middleware mode leaves signals and process exit to this supervisor.
              // A standalone Vite 7 server installs its own exiting SIGTERM handler.
              middlewareMode: { server: listener },
              hmr: { server: listener },
              proxy: gatewayProxy(gateway),
            },
          });
          startup.signal.throwIfAborted();
          listener.on("request", webServer.middlewares);
          await new Promise<void>((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(0, "127.0.0.1", resolve);
          });
          startup.signal.throwIfAborted();
          const address = listener.address();
          if (!address || typeof address === "string") throw new Error("No frontend port");
          const url = `http://127.0.0.1:${address.port}/`;
          console.log(`Browser frontend: ${url}`);
          console.log(JSON.stringify({ type: "browser-ready", url }));
        })();
        await pendingWebStartup;
      } else {
        const output = join(state, "out");
        child = spawn(
          process.execPath,
          [join(root, "node_modules/electron-vite/bin/electron-vite.js"), "dev", "--watch"],
          {
            cwd: root,
            detached: true,
            stdio: ["ignore", "inherit", "inherit"],
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: undefined,
              APP_MODE: values.mode,
              APP_HIDDEN: values.hidden ? "1" : "0",
              APP_PROFILE: join(state, "profile"),
              APP_ROOT: root,
              GATEWAY_URL: services.url,
              DEV_INSTANCE_ID: services.instance,
              ELECTRON_OUTPUT: output,
              ELECTRON_CACHE: join(state, "vite-renderer"),
              ELECTRON_ENTRY: join(output, "main/index.cjs"),
            },
          },
        );
        child.once("error", fail);
        child.once("exit", (code) => {
          if (!stopping) {
            status = code ?? 1;
            child = undefined;
            void stop();
          }
        });
      }
    }
  }
} catch (error) {
  fail(error as Error);
}
