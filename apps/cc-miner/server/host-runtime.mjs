/**
 * host-runtime.mjs — how anything finds the DuckDB host, and the two routes the
 * page needs. The POLICY lives here; the transport glue lives in the adapters.
 *
 * There are three places the page's origin is served from:
 *
 *   `pnpm dev`       Vite dev server        → server/vite-plugin.ts
 *   `pnpm preview`   Vite preview server    → server/vite-plugin.ts
 *   the packaged app Electron `app://`      → electron/app-scheme.mjs
 *
 * All three answer `GET /__duckdb-host` and `POST /quack` identically, because
 * all three call the two functions below. That is deliberate: "a second path to
 * a single truth" is the bug this app keeps finding in itself, and three copies
 * of a proxy would be exactly that. The adapters are allowed to differ — Node's
 * `(req, res)` and the web `Request`/`Response` really are different shapes —
 * but nothing above the adapter is.
 *
 * Plain `.mjs`, not TypeScript, for one reason: the Electron main process runs
 * this file as-is out of a packaged bundle, where there is no transpiler. The
 * types are JSDoc so `tsconfig.node.json` still checks it.
 */
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the host advertises itself.
 *
 * Defaults to the app directory, which is right for a checkout and wrong for a
 * packaged app — inside a `.app` bundle that path is read-only. The packaged
 * shell therefore sets `CC_MINER_HOST_RUNTIME` to a file under `userData` and
 * passes the same value to the sidecar it spawns, so both ends of the lookup
 * agree by construction rather than by coincidence.
 */
export const RUNTIME_FILE =
  process.env.CC_MINER_HOST_RUNTIME || resolve(HERE, "..", ".aiui-cache/duckdb-host.json");

/**
 * @typedef {object} HostRuntime
 * @property {number} port
 * @property {string} token
 * @property {number} pid
 * @property {string} url
 * @property {{kind: "local" | "s3", [k: string]: unknown}} source
 * @property {string} replayBase
 * @property {unknown} manifest
 * @property {unknown} replayIndex
 * @property {string[]} grains
 * @property {string[]} missing
 * @property {string} startedAt
 */

/**
 * The host's advertisement, or null.
 *
 * Read PER REQUEST, deliberately. It makes start order irrelevant: the page's
 * origin can come up first and answer `{ ok: false }` until a host appears, and
 * a host restart (new port, new token) is picked up with nothing to invalidate.
 *
 * @returns {HostRuntime | null}
 */
export function readHostRuntime() {
  try {
    return JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));
  } catch {
    return null;
  }
}

/** What `GET /__duckdb-host` answers. Note what is absent: the port. */
export function hostInfo() {
  const rt = readHostRuntime();
  if (!rt) {
    return {
      ok: false,
      error:
        "no DuckDB host is running — start it with `pnpm serve` (or `pnpm serve --flat` for the legacy flat data layout)",
    };
  }
  return {
    ok: true,
    token: rt.token,
    grains: rt.grains,
    missing: rt.missing,
    source: rt.source,
    replayBase: rt.replayBase,
    manifest: rt.manifest,
    replayIndex: rt.replayIndex,
  };
}

/**
 * Forward a Quack RPC body to the host and return its raw reply.
 *
 * Why proxy at all, when Quack is perfectly happy cross-origin (its reply
 * carries `access-control-allow-origin: *`, and the request is a CORS *simple*
 * request so no preflight fires): so that **no port number ever reaches the
 * client**. The host binds an OS-chosen port and advertises it in the runtime
 * file; the page only ever knows `/quack` on its own origin. A port is a
 * lookup, never an assumption (deployment-shapes.md §1.9).
 *
 * @param {Uint8Array | Buffer} body
 * @param {Record<string, string | string[] | undefined>} [headers]
 * @returns {Promise<{status: number, headers: Record<string, string | string[] | undefined>, body: Buffer}>}
 */
export function forwardQuack(body, headers = {}) {
  const rt = readHostRuntime();
  if (!rt) {
    return Promise.resolve({
      status: 503,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("duckdb host not running"),
    });
  }
  return new Promise((res) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: rt.port,
        path: "/quack",
        method: "POST",
        headers: {
          ...headers,
          host: `127.0.0.1:${rt.port}`,
          "content-length": body.length,
        },
      },
      (up) => {
        /** @type {Buffer[]} */
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () =>
          res({
            status: up.statusCode ?? 200,
            headers: up.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", (e) => {
      // The host died since the file was written. Say so plainly — the
      // alternative is a socket error surfacing as an opaque DuckDB
      // "Failed to send message".
      res({
        status: 502,
        headers: { "content-type": "text/plain" },
        body: Buffer.from(`duckdb host unreachable on :${rt.port} — ${e.message}`),
      });
    });
    req.end(body);
  });
}

/**
 * Read a whole request body. Shared by the Node-side adapters.
 *
 * @param {import("node:stream").Readable} req
 * @returns {Promise<Buffer>}
 */
export function readBody(req) {
  return new Promise((res, rej) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (/** @type {Buffer} */ c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

/**
 * Mount both routes on a Connect-style middleware stack.
 *
 * This is the Node `(req, res)` adapter, used by BOTH Vite servers. Electron
 * has its own adapter because `protocol.handle` speaks web `Request`/`Response`.
 *
 * @param {{use: (path: string, fn: (req: any, res: any) => void) => unknown}} stack
 */
export function mountHostRoutes(stack) {
  stack.use("/__duckdb-host", (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(hostInfo()));
  });

  stack.use("/quack", (req, res) => {
    readBody(req).then(async (body) => {
      const up = await forwardQuack(body, req.headers);
      res.writeHead(up.status, up.headers);
      res.end(up.body);
    });
  });
}
