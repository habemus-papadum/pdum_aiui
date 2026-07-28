/**
 * vite-plugin.ts — makes the DuckDB host reachable from the page, same-origin.
 *
 * Two routes, both dev-server middleware:
 *
 *   GET  /__duckdb-host   → { ok, token, grains, source } or { ok: false, … }
 *   POST /quack           → proxied to the host's Quack RPC endpoint
 *
 * Why a proxy rather than letting the page talk to the host directly: Quack is
 * perfectly happy cross-origin (its RPC response carries `access-control-allow-
 * origin: *`, and the request is a CORS *simple* request so no preflight
 * fires), so this is NOT about CORS. It is about **not putting a port number in
 * the client**. The host binds an OS-chosen port and advertises it in a runtime
 * file; the page only ever knows `/quack` on its own origin. That keeps the one
 * lesson from §1.9 intact — a port is a lookup, never an assumption.
 *
 * The runtime file is read PER REQUEST, deliberately: it makes start order
 * irrelevant. Vite can come up first and start answering `{ ok: false }` until
 * the host appears, and a host restart (new port, new token) is picked up
 * without touching Vite.
 */
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_FILE = resolve(HERE, "..", ".aiui-cache/duckdb-host.json");

interface Runtime {
  port: number;
  token: string;
  pid: number;
  url: string;
  source: { kind: "local" | "s3"; [k: string]: unknown };
  replayBase: string;
  manifest: unknown;
  replayIndex: unknown;
  grains: string[];
  missing: string[];
}

function readRuntime(): Runtime | null {
  try {
    return JSON.parse(readFileSync(RUNTIME_FILE, "utf8")) as Runtime;
  } catch {
    return null;
  }
}

/** The metadata the page needs: the token, and what it can query. Never the port. */
export function duckdbHost(): Plugin {
  return {
    name: "cc-miner:duckdb-host",
    configureServer(server) {
      server.middlewares.use("/__duckdb-host", (_req, res) => {
        const rt = readRuntime();
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(
          JSON.stringify(
            rt
              ? {
                  ok: true,
                  token: rt.token,
                  grains: rt.grains,
                  missing: rt.missing,
                  source: rt.source,
                  replayBase: rt.replayBase,
                  manifest: rt.manifest,
                  replayIndex: rt.replayIndex,
                }
              : {
                  ok: false,
                  error:
                    "no DuckDB host is running — start it with `pnpm serve` (or `pnpm serve --flat` for the legacy flat data layout)",
                },
          ),
        );
      });

      server.middlewares.use("/quack", (req, res) => {
        const rt = readRuntime();
        if (!rt) {
          res.statusCode = 503;
          res.end("duckdb host not running");
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks);
          const up = httpRequest(
            {
              host: "127.0.0.1",
              port: rt.port,
              path: "/quack",
              method: req.method ?? "POST",
              headers: {
                ...req.headers,
                host: `127.0.0.1:${rt.port}`,
                "content-length": body.length,
              },
            },
            (r) => {
              res.writeHead(r.statusCode ?? 200, r.headers);
              r.pipe(res);
            },
          );
          up.on("error", (e) => {
            // The host died since the file was written. Say so plainly — the
            // alternative is a socket error surfacing as an opaque DuckDB
            // "Failed to send message".
            res.statusCode = 502;
            res.end(`duckdb host unreachable on :${rt.port} — ${e.message}`);
          });
          up.end(body);
        });
      });
    },
  };
}
