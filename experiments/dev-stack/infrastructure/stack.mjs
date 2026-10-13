import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createApp } from "../backends/express/app.mjs";
import { backendPlugin } from "./backend-plugin.mjs";
import { processBackend } from "./process-backend.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Own one complete dev instance. No fixed backend ports or shared state files. */
export async function startStack({
  port = 5173,
  host = true,
  signal,
  onFailure = console.error,
} = {}) {
  signal?.throwIfAborted();
  const instance = randomUUID();
  const stateDir = await mkdtemp(join(tmpdir(), "dev-stack-"));
  const backends = [];
  let server;
  let stopping = false;
  let stopPromise;
  let cleanupPromise;
  let ready = false;
  let startupError;
  const cleanupResources = () => {
    cleanupPromise ??= (async () => {
      stopping = true;
      const results = await Promise.allSettled([...backends.map((backend) => backend.stop())]);
      await rm(stateDir, { recursive: true, force: true });
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "Stack cleanup failed");
    })();
    return cleanupPromise;
  };
  const stop = () => {
    stopPromise ??= (async () => {
      stopping = true;
      // Vite's close hook awaits resource disposal. Never call stop from that
      // hook: doing so would recursively wait on the same server.close promise.
      const results = await Promise.allSettled([server?.close()]);
      await cleanupResources();
      if (results[0].status === "rejected") throw results[0].reason;
    })();
    return stopPromise;
  };
  const onExit = (error) => {
    if (!stopping) {
      if (!ready) startupError = error;
      else
        void stop().then(
          () => onFailure(error),
          (cleanupError) => onFailure(cleanupError),
        );
    }
  };
  const env = { DEV_INSTANCE_ID: instance, DEV_STATE_DIR: stateDir, PORT: "0", HOST: "127.0.0.1" };
  try {
    backends.push(
      await processBackend({
        name: "python",
        command: process.env.PYTHON ?? "python3",
        args: ["-u", "backends/python/server.py"],
        cwd: root,
        env,
        onExit,
        signal,
        probePath: "/info",
      }),
    );
    signal?.throwIfAborted();
    if (startupError) throw startupError;
    backends.push(
      await processBackend({
        name: "worker",
        command: process.execPath,
        args: ["backends/worker/dev.mjs"],
        cwd: root,
        env,
        onExit,
        signal,
        probePath: "/info",
      }),
    );
    signal?.throwIfAborted();
    if (startupError) throw startupError;
    server = await createServer({
      configFile: join(root, "vite.config.mjs"),
      cacheDir: join(stateDir, "vite-frontend"),
      plugins: [
        {
          name: "dev-stack-lifecycle",
          async closeServer({ reason }) {
            // A config restart replaces Vite, not the supervised compute stack.
            // On final close this runs after Vite's caches/watchers have closed,
            // including when Vite itself owns the signal-triggered exit path.
            if (reason === "close") await cleanupResources();
          },
        },
        backendPlugin({
          instance,
          middleware: { express: createApp(instance) },
          services: Object.fromEntries(backends.map((backend) => [backend.name, backend])),
        }),
      ],
      server: { host, port },
    });
    await server.listen();
    signal?.throwIfAborted();
    if (startupError) throw startupError;
    ready = true;
    return { instance, stateDir, server, backends, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
