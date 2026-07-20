/**
 * The "website we control" — a LOCAL MOCK of the OIDC→JWT issuer.
 *
 * In production this is a real web app: the user signs in with GitHub (OIDC),
 * we verify their identity, look up their credit balance, and mint a short-lived
 * JWT. Here we stub the identity step and focus on the token machinery that the
 * proxy actually depends on:
 *
 *   POST /login                 { user? }        → { token, claims }   (15-min JWT)
 *   POST /revoke                { jti }          → { ok }              (denylist add)
 *   GET  /.well-known/jwks.json                  → { keys: [ …pub… ] } (proxy fetches once)
 *   GET  /revocations                            → { revoked: [jti…] } (shared denylist view)
 *
 * The private key never leaves here; the proxy verifies with the public key from
 * JWKS. Revocation is exposed as a list the proxy consults — in production a
 * shared cache (Redis) keyed by `jti`, entries expiring with the token.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { ISSUER_PORT, ISSUER_URL, PROXY_URL, TOKEN_TTL_SEC } from "./config.ts";
import { type Claims, generateKeypair, type Keypair, publicJwk, signJwt } from "./jwt.ts";

export interface Issuer {
  keypair: Keypair;
  revoked: Set<string>;
  /** Mint a token for a subject (default 15-min TTL; override for the expiry demo). */
  mint(sub: string, scope: string[], ttlOverrideSec?: number): { token: string; claims: Claims };
  revoke(jti: string): void;
}

export function createIssuer(ttlSec = TOKEN_TTL_SEC): Issuer {
  const keypair = generateKeypair();
  const revoked = new Set<string>();
  return {
    keypair,
    revoked,
    mint(sub, scope, ttlOverrideSec) {
      const now = Math.floor(Date.now() / 1000);
      const claims: Claims = {
        sub,
        jti: randomUUID(),
        iat: now,
        exp: now + (ttlOverrideSec ?? ttlSec),
        iss: ISSUER_URL,
        aud: PROXY_URL,
        scope,
      };
      return { token: signJwt(claims, keypair), claims };
    },
    revoke(jti) {
      revoked.add(jti);
    },
  };
}

// ── HTTP surface ─────────────────────────────────────────────────────────────

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(s),
  });
  res.end(s);
}

export function issuerHandler(issuer: Issuer) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", ISSUER_URL);
    if (req.method === "POST" && url.pathname === "/login") {
      const body = await readJson(req);
      // Stubbed identity. In prod: verify the GitHub OIDC id_token here.
      const user = typeof body.user === "string" ? body.user : "github:demo-user";
      const scope = Array.isArray(body.scope)
        ? (body.scope as string[])
        : ["openai", "gemini", "elevenlabs"];
      const { token, claims } = issuer.mint(user, scope);
      return sendJson(res, 200, { token, claims });
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      const body = await readJson(req);
      if (typeof body.jti !== "string") return sendJson(res, 400, { error: "jti required" });
      issuer.revoke(body.jti);
      return sendJson(res, 200, { ok: true, revoked: body.jti });
    }
    if (req.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      return sendJson(res, 200, { keys: [publicJwk(issuer.keypair)] });
    }
    if (req.method === "GET" && url.pathname === "/revocations") {
      return sendJson(res, 200, { revoked: [...issuer.revoked] });
    }
    sendJson(res, 404, { error: "not found" });
  };
}

export function startIssuer(
  port = ISSUER_PORT,
): Promise<{ issuer: Issuer; server: Server; url: string; close: () => Promise<void> }> {
  const issuer = createIssuer();
  const server = createServer(issuerHandler(issuer));
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        issuer,
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// Run standalone: `npm run issuer`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startIssuer().then(({ url }) => {
    console.log(`mock issuer listening on ${url}`);
    console.log(`  POST ${url}/login   GET ${url}/.well-known/jwks.json   POST ${url}/revoke`);
  });
}
