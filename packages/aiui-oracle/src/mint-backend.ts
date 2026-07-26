/**
 * mint-backend.ts — the HOST-NEUTRAL mint endpoint (node-only, the `./server`
 * subpath): `POST <prefix>/mint` with `{ session }` answers the vendor mint's
 * own wire shape `{ value, expires_at }`, holding the parent key SERVER-side
 * (env-first — the dev posture; the page never sees it).
 *
 * The pencil playbook's seam, deliberately: `handleHttp(req, res): boolean`
 * mounts identically into the lab's Vite dev server (configureServer
 * middleware), a standalone node/express server ({@link runMintServer} — an
 * express app mounts it as `app.use((req,res,next) => handleHttp(req,res) ||
 * next())`), and, later, the channel sidecar — the same code path everywhere
 * is what makes the sidecar claim honest.
 *
 * Keyless degrades LOUDLY (503 with the remedy), never silently.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { mintClientSecret } from "./keys";

export interface MintBackendOptions {
  /** Where the parent key comes from. Default: `process.env.OPENAI_API_KEY`. */
  resolveKey?: () => string | undefined | Promise<string | undefined>;
  /** TTL for minted secrets, seconds (10–7200). Default 600. */
  ttlSeconds?: number;
  /** Mount prefix. Default `/oracle` → the endpoint is `POST /oracle/mint`. */
  prefix?: string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

export interface MintOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** The mint decision, pure of HTTP plumbing — what the tests pin. */
export async function mintOutcome(
  payload: unknown,
  options: MintBackendOptions = {},
): Promise<MintOutcome> {
  const key = await (options.resolveKey ?? (() => process.env.OPENAI_API_KEY))();
  if (key === undefined || key === "") {
    return {
      status: 503,
      body: {
        error:
          "no OPENAI_API_KEY in the mint server's environment — set it (or `aiui keys set openai` " +
          "and export it) and restart the dev server",
      },
    };
  }
  const session =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? ((payload as Record<string, unknown>).session ?? {})
      : {};
  if (session === null || typeof session !== "object" || Array.isArray(session)) {
    return { status: 400, body: { error: "body must be JSON: { session: {…} }" } };
  }
  try {
    const credential = await mintClientSecret(key, session as Record<string, unknown>, {
      ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    return { status: 200, body: { value: credential.ek, expires_at: credential.expiresAt } };
  } catch (error) {
    return {
      status: 502,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export interface MintBackend {
  /** Claim and answer `<prefix>/mint`; false = not ours, caller continues. */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean;
}

export function createMintBackend(options: MintBackendOptions = {}): MintBackend {
  const prefix = options.prefix ?? "/oracle";
  const log = options.log ?? (() => {});
  return {
    handleHttp(req, res) {
      const path = (req.url ?? "").split("?")[0];
      if (path !== `${prefix}/mint`) {
        return false;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "POST only" }));
        return true;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256 * 1024) {
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        let payload: unknown;
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          payload = text === "" ? {} : JSON.parse(text);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "body was not valid JSON" }));
          return;
        }
        void mintOutcome(payload, options).then((outcome) => {
          log(`oracle mint: ${outcome.status}`);
          res.writeHead(outcome.status, { "content-type": "application/json" });
          res.end(JSON.stringify(outcome.body));
        });
      });
      return true;
    },
  };
}

/**
 * The standalone runner — the future channel sidecar's functionality as its
 * own little server, today. `npx tsx -e 'import("@habemus-papadum/aiui-oracle/server").then(m => m.runMintServer({ port: 8787 }))'`
 */
export async function runMintServer(
  options: MintBackendOptions & { port?: number } = {},
): Promise<{ port: number; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const backend = createMintBackend(options);
  const log = options.log ?? ((line: string) => console.error(line));
  const server = createServer((req, res) => {
    if (!backend.handleHttp(req, res)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found — the endpoint is POST /oracle/mint" }));
    }
  });
  const port = options.port ?? 8787;
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  log(`oracle mint server on http://127.0.0.1:${port}/oracle/mint`);
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
