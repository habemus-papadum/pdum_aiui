/**
 * Per-vendor ephemeral-credential minting. Each function performs the live mint
 * HTTP call and returns a {@link MintedKey}. Shared by `mint.ts` (the CLI, 20-min
 * keys → cache) and `test-keys.ts` (which re-mints SHORT-TTL keys for the
 * expiry test). Every detail here is grounded in `RESEARCH.md`.
 */

import type { MintedKey, VendorId } from "./spec.ts";
import { isoIn } from "./util.ts";

/** Read a required env var (the long-lived PARENT credential) or throw. */
export function requireParent(env: string): string {
  const v = process.env[env];
  if (!v) throw new Error(`missing ${env} in environment (needed to mint from)`);
  return v;
}

/** POST JSON and return the parsed body, throwing a rich error on non-2xx. */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`mint failed: HTTP ${res.status} ${res.statusText} — ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`mint returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

// ── OpenAI realtime ──────────────────────────────────────────────────────────
// POST /v1/realtime/client_secrets ; token is the `value` field (ek_…).
// Two channel surfaces → two token shapes.

export const OPENAI_LINTER_MODEL = "gpt-realtime-2";
export const OPENAI_TRANSCRIBE_MODEL = "gpt-realtime-whisper";

export type OpenAiRealtimeKind = "linter" | "transcription";

export async function mintOpenAiRealtime(
  kind: OpenAiRealtimeKind,
  ttlSeconds: number,
): Promise<MintedKey> {
  const parent = requireParent("OPENAI_API_KEY");
  const session =
    kind === "linter"
      ? { type: "realtime", model: OPENAI_LINTER_MODEL, output_modalities: ["text"] }
      : {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: OPENAI_TRANSCRIBE_MODEL },
              turn_detection: null,
            },
          },
        };
  const body = { expires_after: { anchor: "created_at", seconds: ttlSeconds }, session };
  const out = await postJson(
    "https://api.openai.com/v1/realtime/client_secrets",
    { authorization: `Bearer ${parent}` },
    body,
  );
  const value = out.value;
  if (typeof value !== "string")
    throw new Error(`no client-secret 'value' in response: ${JSON.stringify(out).slice(0, 200)}`);
  const expUnix = typeof out.expires_at === "number" ? out.expires_at : null;
  return {
    vendor: "openai",
    surface: kind === "linter" ? "realtime-linter" : "realtime-transcription",
    token: value,
    auth: { kind: "bearer" },
    mintedAt: new Date().toISOString(),
    expiresAt: expUnix ? new Date(expUnix * 1000).toISOString() : isoIn(ttlSeconds),
    ttlSeconds,
    scopedModels: [kind === "linter" ? OPENAI_LINTER_MODEL : OPENAI_TRANSCRIBE_MODEL],
    detail: { echoedSession: out.session },
  };
}

// ── Gemini Live ──────────────────────────────────────────────────────────────
// POST /v1alpha/auth_tokens (x-goog-api-key header) ; token is the full `name`.

export const GEMINI_MODEL = "gemini-3.1-flash-live-preview";

export async function mintGeminiLive(
  expireSeconds: number,
  newSessionSeconds: number,
): Promise<MintedKey> {
  const parent = requireParent("GEMINI_API_KEY");
  const body = {
    uses: 1,
    expireTime: isoIn(expireSeconds),
    newSessionExpireTime: isoIn(newSessionSeconds),
    bidiGenerateContentSetup: {
      model: `models/${GEMINI_MODEL}`,
      // This live model only supports AUDIO out (TEXT → 1007 "combination …
      // not supported"). The config is baked into the token (no fieldMask),
      // so it must be right at mint time; the connect-time setup frame is ignored.
      generationConfig: { responseModalities: ["AUDIO"] },
    },
  };
  const out = await postJson(
    "https://generativelanguage.googleapis.com/v1alpha/auth_tokens",
    { "x-goog-api-key": parent },
    body,
  );
  const name = out.name;
  if (typeof name !== "string")
    throw new Error(`no auth_tokens 'name' in response: ${JSON.stringify(out).slice(0, 200)}`);
  return {
    vendor: "gemini",
    surface: "live",
    token: name,
    auth: { kind: "query", param: "access_token" },
    mintedAt: new Date().toISOString(),
    expiresAt: typeof out.expireTime === "string" ? out.expireTime : isoIn(expireSeconds),
    ttlSeconds: expireSeconds,
    scopedModels: [GEMINI_MODEL],
    detail: { newSessionExpireTime: out.newSessionExpireTime, uses: out.uses },
  };
}

// ── ElevenLabs Scribe realtime STT ───────────────────────────────────────────
// POST /v1/single-use-token/realtime_scribe (xi-api-key) ; single-use, 15-min fixed.

export const ELEVENLABS_MODEL = "scribe_v2_realtime";
export const ELEVENLABS_TTL_SECONDS = 15 * 60; // fixed by the vendor, not configurable

export async function mintElevenLabsScribe(): Promise<MintedKey> {
  const parent = requireParent("ELEVEN_LABS_API_KEY");
  const out = await postJson(
    "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
    { "xi-api-key": parent },
    {},
  );
  const token = out.token;
  if (typeof token !== "string")
    throw new Error(`no 'token' in response: ${JSON.stringify(out).slice(0, 200)}`);
  return {
    vendor: "elevenlabs",
    surface: "stt-realtime",
    token,
    auth: { kind: "query", param: "token" },
    mintedAt: new Date().toISOString(),
    expiresAt: isoIn(ELEVENLABS_TTL_SECONDS),
    ttlSeconds: ELEVENLABS_TTL_SECONDS,
    scopedModels: [ELEVENLABS_MODEL],
    singleUse: true,
    note: "TTL fixed at 15 min by the vendor (not the 20-min target); token is single-use.",
  };
}

/** The vendors this exploration can mint ephemeral credentials for. */
export const MINTABLE_VENDORS: VendorId[] = ["openai", "gemini", "elevenlabs"];
