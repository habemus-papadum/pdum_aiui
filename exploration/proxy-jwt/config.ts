/**
 * Shared config for the proxy exploration: ports, token lifetime, the vendor
 * route table, and the two auth-plumbing helpers that make the whole thing work:
 *
 *  - `extractIncomingToken` — pull the JWT out of a client request REGARDLESS of
 *    which slot it arrived in (Bearer header / `xi-api-key` / `?key=` / `?token=`
 *    / `?access_token=`). This is what lets the channel switch to proxy mode with
 *    NO code change: each vendor's existing socket factory keeps putting the
 *    credential where it always did, and the proxy finds it there.
 *  - `injectUpstreamAuth` — put the REAL vendor key where THAT vendor expects it.
 */

export const ISSUER_PORT = 8788;
export const PROXY_PORT = 8789;
export const ISSUER_URL = `http://127.0.0.1:${ISSUER_PORT}`;
export const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
export const PROXY_WS_URL = `ws://127.0.0.1:${PROXY_PORT}`;

/** Access-token lifetime: 15 minutes (self-expiring). */
export const TOKEN_TTL_SEC = 15 * 60;

export type Vendor = "openai" | "gemini" | "elevenlabs";
export type VendorAuth = "bearer" | "xi-api-key" | "query-key";

/** How each vendor wants its REAL key presented (also where a JWT may hide). */
export const VENDOR_AUTH: Record<Vendor, VendorAuth> = {
  openai: "bearer",
  gemini: "query-key", // ?key=
  elevenlabs: "xi-api-key",
};

export const VENDOR_ENV: Record<Vendor, string> = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  elevenlabs: "ELEVEN_LABS_API_KEY",
};

// ── WS route table (proxy surface → real upstream) ───────────────────────────

export interface WsRoute {
  vendor: Vendor;
  surface: string;
  upstreamUrl: string;
  /** Client query params to forward upstream (the rest — incl. any token — dropped). */
  forwardQuery: string[];
}

export const WS_ROUTES: Record<string, WsRoute> = {
  "openai/realtime-transcription": {
    vendor: "openai",
    surface: "realtime-transcription",
    upstreamUrl: "wss://api.openai.com/v1/realtime?intent=transcription",
    forwardQuery: [],
  },
  "openai/realtime-linter": {
    vendor: "openai",
    surface: "realtime-linter",
    upstreamUrl: "wss://api.openai.com/v1/realtime?model=gpt-realtime-2",
    forwardQuery: [],
  },
  "elevenlabs/stt-realtime": {
    vendor: "elevenlabs",
    surface: "stt-realtime",
    upstreamUrl: "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
    forwardQuery: ["model_id", "audio_format", "include_timestamps", "language_code"],
  },
  "gemini/live": {
    vendor: "gemini",
    surface: "live",
    upstreamUrl:
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
    forwardQuery: [],
  },
};

// ── REST route table ─────────────────────────────────────────────────────────

export interface RestRoute {
  vendor: Vendor;
  upstreamBase: string;
}

/** Only OpenAI REST is used by the channel (TTS + chat) — the surfaces with NO
 * ephemeral-key option, which the proxy solves by holding the key server-side. */
export const REST_ROUTES: Record<string, RestRoute> = {
  openai: { vendor: "openai", upstreamBase: "https://api.openai.com" },
};

// ── the two auth-plumbing helpers ────────────────────────────────────────────

/** Names we accept an inbound JWT under (case-insensitive header / query). */
const TOKEN_QUERY_KEYS = ["token", "access_token", "key"];

/**
 * Find the client's JWT wherever the channel's per-vendor factory placed it:
 *   OpenAI      → `Authorization: Bearer <jwt>`
 *   ElevenLabs  → `xi-api-key: <jwt>`
 *   Gemini      → `?key=<jwt>`
 * plus `?token=` / `?access_token=` for browser WS clients that can't set headers.
 */
export function extractIncomingToken(
  headers: Record<string, string | string[] | undefined>,
  url: URL,
): string | null {
  const auth = headerValue(headers, "authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  const xi = headerValue(headers, "xi-api-key");
  if (xi) return xi.trim();

  for (const k of TOKEN_QUERY_KEYS) {
    const v = url.searchParams.get(k);
    if (v) return v.trim();
  }
  return null;
}

/** Apply the REAL vendor key to an upstream request, in that vendor's own style. */
export function injectUpstreamAuth(
  vendor: Vendor,
  key: string,
  headers: Record<string, string>,
  upstream: URL,
): void {
  switch (VENDOR_AUTH[vendor]) {
    case "bearer":
      headers.authorization = `Bearer ${key}`;
      break;
    case "xi-api-key":
      headers["xi-api-key"] = key;
      break;
    case "query-key":
      upstream.searchParams.set("key", key);
      break;
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
