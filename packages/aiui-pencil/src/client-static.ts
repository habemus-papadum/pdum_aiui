/**
 * client-static.ts — serve the built remote-pencil client (node side).
 *
 * The iPad has no frontend process, so the relay hands it the client app at
 * `GET <prefix>/` — the one page-serving exception the channel's "JSON routes
 * only" posture allows, inherited from paint. The app itself is a real built
 * Solid bundle (`lab/vite.client.config.ts` → `assets/client/`), not a
 * hand-written HTML string.
 *
 * Deliberately hand-rolled rather than `express.static`: the sidecar receives
 * an Express *app* but must not import Express at runtime (it would resolve a
 * second copy beside the channel's own), and thirty lines of static serving
 * with a traversal guard is cheaper than that risk.
 *
 * When the artifact has not been built (a fresh checkout — `assets/client/`
 * is gitignored), `<prefix>/` answers 503 with the command to run, instead of
 * a bare 404 that reads as "the sidecar is broken".
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** `../assets/client` — the same path from `src/` (tsx) and `dist/` (installed). */
export function defaultClientDir(): string {
  return fileURLToPath(new URL("../assets/client", import.meta.url));
}

export interface ClientStatic {
  /** Handle a GET under the prefix. Returns true if handled. */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
}

export function clientStatic(prefix: string, dir: string = defaultClientDir()): ClientStatic {
  const root = resolve(dir);

  const handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    if ((req.method ?? "GET") !== "GET") {
      return false;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return false;
    }
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
      return false;
    }
    let rel = pathname === prefix ? "/" : pathname.slice(prefix.length);
    if (rel === "/" || rel === "") {
      rel = "/index.html";
    }

    const file = resolve(join(root, normalize(rel)));
    if (!file.startsWith(root)) {
      res.statusCode = 403;
      res.end();
      return true; // a traversal attempt is OURS to refuse, not to pass along
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (rel === "/index.html") {
        res.statusCode = 503;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(
          "The remote-pencil client has not been built.\n\n" +
            "  pnpm -C packages/aiui-pencil build:client\n\n" +
            `(serving from ${root})\n`,
        );
        return true;
      }
      return false; // an unknown asset path may belong to someone else
    }

    const dot = file.lastIndexOf(".");
    const type = dot >= 0 ? TYPES[file.slice(dot)] : undefined;
    res.statusCode = 200;
    if (type) {
      res.setHeader("Content-Type", type);
    }
    res.end(readFileSync(file));
    return true;
  };

  return { handle };
}
