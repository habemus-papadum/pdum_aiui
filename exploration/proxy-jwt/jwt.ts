/**
 * A dependency-free EdDSA (Ed25519) JWT + JWKS implementation on top of
 * `node:crypto`. Deliberately tiny — enough to demonstrate the real
 * issue→verify→expire→revoke lifecycle without pulling in a JWT library.
 *
 * Why EdDSA / asymmetric (not HS256): it is what makes the proxy STATELESS and
 * horizontally scalable. The issuer holds the PRIVATE key and signs; every proxy
 * replica needs only the PUBLIC key (fetched once from the issuer's JWKS
 * endpoint) to verify — no shared secret, no per-request call back to the
 * issuer. This mirrors production OIDC.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";

// ── base64url ────────────────────────────────────────────────────────────────

function b64u(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}
function b64uJson(obj: unknown): string {
  return b64u(JSON.stringify(obj));
}
function fromB64uJson<T>(s: string): T {
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as T;
}

// ── keys ─────────────────────────────────────────────────────────────────────

export interface Keypair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
}

/** Generate an Ed25519 keypair with a stable key id derived from the public key. */
export function generateKeypair(): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const kid = (jwk.x ?? "").slice(0, 16) || "key-1";
  return { privateKey, publicKey, kid };
}

/** A single JWKS entry (public Ed25519 key). */
export interface Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
}

export function publicJwk(kp: Keypair): Jwk {
  const jwk = kp.publicKey.export({ format: "jwk" }) as { kty: "OKP"; crv: "Ed25519"; x: string };
  return { ...jwk, kid: kp.kid, alg: "EdDSA", use: "sig" };
}

export function keyFromJwk(jwk: Jwk): KeyObject {
  return createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: "jwk" });
}

// ── claims ───────────────────────────────────────────────────────────────────

export interface Claims {
  /** Subject — the authenticated user (e.g. `github:octocat`). */
  sub: string;
  /** Unique token id — the unit of revocation. */
  jti: string;
  /** Issued-at (unix seconds). */
  iat: number;
  /** Expiry (unix seconds). */
  exp: number;
  /** Issuer URL. */
  iss: string;
  /** Audience — the proxy this token is good for. */
  aud: string;
  /** What the token may do (vendors/surfaces). Coarse scope for the PoC. */
  scope: string[];
  [k: string]: unknown;
}

// ── sign / verify ────────────────────────────────────────────────────────────

export function signJwt(claims: Claims, kp: Keypair): string {
  const header = { alg: "EdDSA", typ: "JWT", kid: kp.kid };
  const signingInput = `${b64uJson(header)}.${b64uJson(claims)}`;
  const sig = sign(null, Buffer.from(signingInput), kp.privateKey);
  return `${signingInput}.${b64u(sig)}`;
}

export type VerifyResult =
  | { ok: true; claims: Claims }
  | {
      ok: false;
      reason: string;
      code: "malformed" | "bad_signature" | "expired" | "not_yet_valid";
    };

export interface VerifyOptions {
  publicKey: KeyObject;
  /** Current time in unix seconds (injectable for tests). */
  now?: number;
  /** Small clock-skew allowance, seconds. */
  leewaySec?: number;
}

/**
 * Verify signature + expiry. STATELESS — no I/O, no issuer round-trip. Revocation
 * (a `jti` denylist) is a SEPARATE, shared check the proxy layers on top; see
 * proxy.ts. Keeping them separate is the whole point: signature+exp is local and
 * infinitely scalable; only revocation touches shared state.
 */
export function verifyJwt(token: string, opts: VerifyOptions): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "not a 3-part JWT", code: "malformed" };
  const [h, p, s] = parts;
  const signingInput = `${h}.${p}`;
  let sigOk = false;
  try {
    sigOk = verify(null, Buffer.from(signingInput), opts.publicKey, Buffer.from(s, "base64url"));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: "signature does not verify", code: "bad_signature" };

  let claims: Claims;
  try {
    claims = fromB64uJson<Claims>(p);
  } catch {
    return { ok: false, reason: "payload is not JSON", code: "malformed" };
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const leeway = opts.leewaySec ?? 5;
  if (typeof claims.exp === "number" && now > claims.exp + leeway) {
    return { ok: false, reason: `expired at ${claims.exp} (now ${now})`, code: "expired" };
  }
  if (typeof claims.iat === "number" && now + leeway < claims.iat - leeway) {
    return { ok: false, reason: "iat in the future", code: "not_yet_valid" };
  }
  return { ok: true, claims };
}

/** Decode claims WITHOUT verifying (for logging only — never trust this). */
export function decodeUnsafe(token: string): Claims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return fromB64uJson<Claims>(parts[1]);
  } catch {
    return null;
  }
}

export { createPrivateKey };
