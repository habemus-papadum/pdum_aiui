/**
 * The STATELESS proxy. Any number of replicas can run behind a load balancer:
 * each verifies the JWT locally (public key from the issuer's JWKS), consults a
 * shared revocation view, injects the REAL vendor key (held server-side, never
 * seen by the client), forwards to the vendor, and emits a usage/metering event.
 *
 *   REST:  POST /rest/<vendor>/<subpath...>   → https://<vendor>/<subpath>
 *   WS:    /ws/<vendor>/<surface>             → wss://<vendor>/…
 *   GET  /usage                               → per-subject metering + balance
 *
 * The only non-local state is (a) the JWKS (fetched once) and (b) the revocation
 * denylist (fetched with a short cache) — both read-only, both shared, neither
 * pinning a user to a replica. Balance/metering is shown here in-memory for the
 * demo; in production those events flow to an external metering/billing pipeline
 * and the balance check hits a shared store. Marked inline where that boundary is.
 */

import type { KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  extractIncomingToken,
  ISSUER_URL,
  injectUpstreamAuth,
  PROXY_PORT,
  PROXY_URL,
  REST_ROUTES,
  VENDOR_ENV,
  type Vendor,
  WS_ROUTES,
} from "./config.ts";
import { type Claims, type Jwk, keyFromJwk, verifyJwt } from "./jwt.ts";

// ── shared, read-only state fetched from the issuer ──────────────────────────

async function fetchPublicKey(jwksUrl: string): Promise<KeyObject> {
  const res = await fetch(jwksUrl);
  const body = (await res.json()) as { keys: Jwk[] };
  if (!body.keys?.length) throw new Error(`no keys in JWKS at ${jwksUrl}`);
  return keyFromJwk(body.keys[0]);
}

/** Revocation denylist with a short TTL cache (prod: a shared Redis lookup by jti). */
function makeRevocationView(revocationsUrl: string, cacheMs = 3000) {
  let cache: Set<string> = new Set();
  let fetchedAt = 0;
  return async (): Promise<Set<string>> => {
    const now = Date.now();
    if (now - fetchedAt > cacheMs) {
      try {
        const res = await fetch(revocationsUrl);
        const body = (await res.json()) as { revoked: string[] };
        cache = new Set(body.revoked ?? []);
        fetchedAt = now;
      } catch {
        // keep the stale view on a transient issuer hiccup
      }
    }
    return cache;
  };
}

// ── metering / balance (demo-local; prod = external pipeline + shared store) ──

export interface UsageEvent {
  at: string;
  sub: string;
  vendor: Vendor;
  surface: string;
  /** Micro-credits charged for this call. */
  cost: number;
  detail: Record<string, unknown>;
}

export interface Meter {
  events: UsageEvent[];
  balances: Map<string, number>;
  startingBalance: number;
  balanceOf(sub: string): number;
  hasCredit(sub: string): boolean;
  charge(e: Omit<UsageEvent, "at">): void;
}

export function createMeter(startingBalance = 100_000): Meter {
  const balances = new Map<string, number>();
  const events: UsageEvent[] = [];
  const balanceOf = (sub: string) => balances.get(sub) ?? startingBalance;
  return {
    events,
    balances,
    startingBalance,
    balanceOf,
    hasCredit: (sub) => balanceOf(sub) > 0,
    charge(e) {
      balances.set(e.sub, balanceOf(e.sub) - e.cost);
      events.push({ ...e, at: new Date().toISOString() });
    },
  };
}

// ── auth ─────────────────────────────────────────────────────────────────────

export type AuthOutcome =
  | { ok: true; claims: Claims }
  | { ok: false; status: number; reason: string };

export type Authenticator = (
  headers: Record<string, string | string[] | undefined>,
  url: URL,
) => Promise<AuthOutcome>;

function makeAuthenticator(
  publicKey: KeyObject,
  revoked: () => Promise<Set<string>>,
): Authenticator {
  return async (headers, url) => {
    const token = extractIncomingToken(headers, url);
    if (!token) return { ok: false, status: 401, reason: "no token (Bearer / xi-api-key / ?key=)" };
    const v = verifyJwt(token, { publicKey });
    if (!v.ok) return { ok: false, status: 401, reason: `token ${v.code}: ${v.reason}` };
    if (v.claims.aud !== PROXY_URL) return { ok: false, status: 401, reason: "wrong audience" };
    if ((await revoked()).has(v.claims.jti))
      return { ok: false, status: 401, reason: "token revoked" };
    return { ok: true, claims: v.claims };
  };
}

// ── the proxy ────────────────────────────────────────────────────────────────

export interface ProxyDeps {
  authenticate: Authenticator;
  meter: Meter;
}

function vendorKey(vendor: Vendor): string {
  const k = process.env[VENDOR_ENV[vendor]];
  if (!k) throw new Error(`proxy missing ${VENDOR_ENV[vendor]} server-side`);
  return k;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(s);
}

/** REST: verify → balance-gate → inject real key → forward → meter. */
async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ProxyDeps,
): Promise<void> {
  // /rest/<vendor>/<subpath...>
  const m = url.pathname.match(/^\/rest\/([^/]+)\/(.+)$/);
  if (!m) return sendJson(res, 404, { error: "bad rest path; want /rest/<vendor>/<subpath>" });
  const route = REST_ROUTES[m[1]];
  if (!route) return sendJson(res, 404, { error: `no REST route for ${m[1]}` });

  const auth = await deps.authenticate(req.headers, url);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.reason });
  if (!deps.meter.hasCredit(auth.claims.sub)) {
    return sendJson(res, 402, {
      error: "insufficient credits",
      balance: deps.meter.balanceOf(auth.claims.sub),
    });
  }

  const upstream = new URL(`${route.upstreamBase}/${m[2]}`);
  upstream.search = url.search;
  const headers: Record<string, string> = {};
  const ct = req.headers["content-type"];
  if (typeof ct === "string") headers["content-type"] = ct;
  injectUpstreamAuth(route.vendor, vendorKey(route.vendor), headers, upstream);

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const upRes = await fetch(upstream, { method: req.method, headers, body });
  const buf = Buffer.from(await upRes.arrayBuffer());

  // Meter: prefer real token usage from a JSON response; else charge by bytes.
  const upCt = upRes.headers.get("content-type") ?? "";
  let cost = Math.max(1, Math.ceil(buf.byteLength / 1000));
  let detail: Record<string, unknown> = { bytes: buf.byteLength, status: upRes.status };
  if (upCt.includes("application/json")) {
    try {
      const j = JSON.parse(buf.toString("utf8")) as { usage?: Record<string, number> };
      if (j.usage) {
        const t =
          (j.usage.total_tokens ??
            (j.usage.prompt_tokens ?? 0) + (j.usage.completion_tokens ?? 0)) ||
          0;
        cost = Math.max(1, t);
        detail = { usage: j.usage, status: upRes.status };
      }
    } catch {
      // non-usage json — keep byte cost
    }
  }
  deps.meter.charge({
    sub: auth.claims.sub,
    vendor: route.vendor,
    surface: `rest:${m[2]}`,
    cost,
    detail,
  });

  res.writeHead(upRes.status, { "content-type": upCt || "application/octet-stream" });
  res.end(buf);
}

/** WS upgrade: verify → open upstream with real key → pipe → meter bytes. */
function attachWsProxy(server: Server, deps: ProxyDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const url = new URL(req.url ?? "/", PROXY_URL);
      const m = url.pathname.match(/^\/ws\/([^/]+)\/([^/]+)$/);
      const route = m ? WS_ROUTES[`${m[1]}/${m[2]}`] : undefined;
      if (!route) return rejectUpgrade(socket, 404, "no such WS route");

      const auth = await deps.authenticate(req.headers, url);
      if (!auth.ok) return rejectUpgrade(socket, auth.status, auth.reason);
      if (!deps.meter.hasCredit(auth.claims.sub))
        return rejectUpgrade(socket, 402, "insufficient credits");

      // Build the upstream URL: base + only the whitelisted client query params.
      const upstream = new URL(route.upstreamUrl);
      for (const p of route.forwardQuery) {
        const v = url.searchParams.get(p);
        if (v !== null) upstream.searchParams.set(p, v);
      }
      const upHeaders: Record<string, string> = {};
      injectUpstreamAuth(route.vendor, vendorKey(route.vendor), upHeaders, upstream);

      wss.handleUpgrade(req, socket, head, (client) => {
        pipeWs(
          client,
          upstream.toString(),
          upHeaders,
          route.vendor,
          route.surface,
          auth.claims.sub,
          deps.meter,
        );
      });
    })().catch((e) => rejectUpgrade(socket, 500, String((e as Error).message)));
  });
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const text =
    {
      401: "Unauthorized",
      402: "Payment Required",
      404: "Not Found",
      500: "Internal Server Error",
    }[status] ?? "Error";
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${reason}`,
  );
  socket.destroy();
}

/** Bridge client ↔ upstream, counting bytes each way; charge on close. */
function pipeWs(
  client: WebSocket,
  upstreamUrl: string,
  upHeaders: Record<string, string>,
  vendor: Vendor,
  surface: string,
  sub: string,
  meter: Meter,
): void {
  const upstream = new WebSocket(upstreamUrl, { headers: upHeaders });
  let bytesUp = 0;
  let bytesDown = 0;
  const clientQueue: Array<Buffer | string> = [];
  let upstreamOpen = false;

  upstream.on("open", () => {
    upstreamOpen = true;
    for (const m of clientQueue.splice(0)) upstream.send(m);
  });
  upstream.on("message", (data, isBinary) => {
    bytesDown += bufLen(data);
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", (code, reason) => {
    if (client.readyState === WebSocket.OPEN)
      client.close(code >= 3000 || code === 1000 ? code : 1011, reason);
  });
  upstream.on("error", () => {
    if (client.readyState === WebSocket.OPEN) client.close(1011, "upstream error");
  });

  client.on("message", (data, isBinary) => {
    bytesUp += bufLen(data);
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN)
      upstream.send(data, { binary: isBinary });
    else clientQueue.push(isBinary ? (data as Buffer) : data.toString());
  });
  const done = () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)
      upstream.close();
    // Meter by traffic (a stand-in; prod parses vendor usage events).
    const cost = Math.max(1, Math.ceil((bytesUp + bytesDown) / 1000));
    meter.charge({ sub, vendor, surface: `ws:${surface}`, cost, detail: { bytesUp, bytesDown } });
  };
  client.on("close", done);
  client.on("error", done);
}

function bufLen(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((n, d) => n + bufLen(d), 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return 0;
}

// ── assembly ─────────────────────────────────────────────────────────────────

export async function startProxy(opts?: {
  port?: number;
  jwksUrl?: string;
  revocationsUrl?: string;
  meter?: Meter;
  /** Revocation-view cache window (ms). Small in the demo for a snappy revoke. */
  revocationCacheMs?: number;
}): Promise<{ server: Server; meter: Meter; url: string; close: () => Promise<void> }> {
  const port = opts?.port ?? PROXY_PORT;
  const jwksUrl = opts?.jwksUrl ?? `${ISSUER_URL}/.well-known/jwks.json`;
  const revocationsUrl = opts?.revocationsUrl ?? `${ISSUER_URL}/revocations`;
  const meter = opts?.meter ?? createMeter();

  const publicKey = await fetchPublicKey(jwksUrl);
  const authenticate = makeAuthenticator(
    publicKey,
    makeRevocationView(revocationsUrl, opts?.revocationCacheMs ?? 3000),
  );
  const deps: ProxyDeps = { authenticate, meter };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", PROXY_URL);
    if (req.method === "GET" && url.pathname === "/usage") {
      return sendJson(res, 200, {
        startingBalance: meter.startingBalance,
        balances: Object.fromEntries(meter.balances),
        events: meter.events,
      });
    }
    if (url.pathname.startsWith("/rest/")) {
      handleRest(req, res, url, deps).catch((e) =>
        sendJson(res, 502, { error: String((e as Error).message) }),
      );
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
  attachWsProxy(server, deps);

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({
        server,
        meter,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    );
  });
}

// Run standalone: `npm run proxy` (needs the issuer already running for JWKS)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startProxy()
    .then(({ url }) => console.log(`stateless proxy listening on ${url} (JWKS from ${ISSUER_URL})`))
    .catch((e) => {
      console.error(`proxy failed to start: ${(e as Error).message}`);
      console.error(`(is the issuer running? \`npm run issuer\`)`);
      process.exit(1);
    });
}
