import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join, resolve, sep } from "node:path";
import { processBackend } from "../../../dev-stack/infrastructure/process-backend.mjs";

export interface BackendHandle {
  name: string;
  url: string;
  pid: number;
  stop(): Promise<void>;
}
interface ServiceOptions {
  root: string;
  node: string;
  python: string;
  stateDir: string;
  workerUrl: string;
  staticDir?: string;
  onFailure?: (error: Error) => void;
  signal?: AbortSignal;
}

/** Same source runs in the Node dev supervisor and Electron's packaged main process. */
export async function startServices(options: ServiceOptions) {
  options.signal?.throwIfAborted();
  const instance = randomUUID();
  const token = randomBytes(24).toString("hex");
  const handles: BackendHandle[] = [];
  let ready = false;
  let stopping = false;
  let startupError: Error | undefined;
  let stopPromise: Promise<void> | undefined;
  const server = createServer(async (req, res) => {
    try {
      const incoming = new URL(req.url ?? "/", "http://localhost");
      const prefix = `/${token}/`;
      if (!incoming.pathname.startsWith(prefix)) {
        res.writeHead(404).end();
        return;
      }
      const path = incoming.pathname.slice(prefix.length);
      if (path === "api/runtime") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(
          JSON.stringify({
            instance,
            pid: process.pid,
            backends: handles.map(({ name, pid }) => ({ name, pid })),
          }),
        );
        return;
      }
      const match = /^api\/(express|python|worker)(\/.*)?$/.exec(path);
      if (match) {
        const origin =
          match[1] === "worker" ? options.workerUrl : handles.find((b) => b.name === match[1])?.url;
        if (!origin) {
          res.writeHead(503).end();
          return;
        }
        const target = new URL(origin);
        target.pathname = `${target.pathname.replace(/\/$/, "")}${match[2] ?? "/"}`;
        target.search = incoming.search;
        const headers = { ...req.headers, host: target.host };
        delete headers.origin;
        const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(
          target,
          { method: req.method, headers },
          (reply) => {
            // A truncated upstream must terminate the downstream stream too.
            reply.once("aborted", () => res.destroy());
            reply.once("error", () => res.destroy());
            res.writeHead(reply.statusCode ?? 502, {
              ...reply.headers,
              "cache-control": "no-store",
            });
            reply.pipe(res);
          },
        );
        upstream.setTimeout(15_000, () => upstream.destroy(new Error("Backend timeout")));
        upstream.on("error", (error) => {
          if (res.destroyed) return;
          if (res.headersSent) {
            res.destroy();
            return;
          }
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        });
        req.on("aborted", () => upstream.destroy());
        // Request upload may already be complete when the client cancels a response.
        res.once("close", () => upstream.destroy());
        req.pipe(upstream);
        return;
      }
      if (path.startsWith("api/")) {
        res.writeHead(404).end();
        return;
      }
      if (!options.staticDir || !["GET", "HEAD"].includes(req.method ?? "")) {
        res.writeHead(404).end();
        return;
      }
      const base = resolve(options.staticDir);
      const file = resolve(base, decodeURIComponent(path || "index.html"));
      if (!file.startsWith(`${base}${sep}`)) {
        res.writeHead(400).end();
        return;
      }
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        res.writeHead(404).end();
        return;
      }
      const types: Record<string, string> = {
        html: "text/html",
        js: "text/javascript",
        css: "text/css",
        svg: "image/svg+xml",
      };
      res.writeHead(200, {
        "Content-Type": types[file.split(".").at(-1) ?? ""] ?? "application/octet-stream",
        "Content-Length": info.size,
      });
      if (req.method === "HEAD") res.end();
      else
        createReadStream(file)
          .on("error", () => res.destroy())
          .pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  const stop = () => {
    stopPromise ??= (async () => {
      stopping = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(handles.map((backend) => backend.stop()));
    })();
    return stopPromise;
  };
  const onExit = (error: Error) => {
    if (stopping) return;
    if (!ready) startupError = error;
    else void stop().then(() => options.onFailure?.(error));
  };
  try {
    const worker = new URL(options.workerUrl);
    if (!["http:", "https:"].includes(worker.protocol))
      throw new Error("Worker URL must be HTTP(S)");
    const env = {
      DEV_INSTANCE_ID: instance,
      DEV_STATE_DIR: options.stateDir,
      HOST: "127.0.0.1",
      PORT: "0",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONHOME: "",
      PYTHONPATH: "",
    };
    for (const [name, command, args] of [
      ["express", options.node, [join(options.root, "backends/express/server.mjs")]],
      ["python", options.python, ["-u", join(options.root, "backends/python/server.py")]],
    ] as const) {
      handles.push(
        (await processBackend({
          name,
          command,
          args: [...args],
          cwd: options.root,
          env,
          onExit,
          probePath: "/info",
          signal: options.signal,
          timeout: 30_000,
        })) as BackendHandle,
      );
      if (startupError) throw startupError;
      options.signal?.throwIfAborted();
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    options.signal?.throwIfAborted();
    if (startupError) throw startupError;
    ready = true;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No bound gateway port");
    return { instance, url: `http://127.0.0.1:${address.port}/${token}/`, handles, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
