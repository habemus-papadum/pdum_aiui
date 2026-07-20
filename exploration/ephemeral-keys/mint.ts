/**
 * Standalone command A — mint 20-minute, model/API-scoped ephemeral credentials
 * for the channel's three vendors and cache them.
 *
 *   npm run mint            (from exploration/ephemeral-keys/)
 *   npx tsx mint.ts
 *
 * Not integrated into anything. Reads the long-lived PARENT keys from the env
 * (OPENAI_API_KEY / GEMINI_API_KEY / ELEVEN_LABS_API_KEY), mints short-lived
 * scoped tokens, and writes them to `.aiui-cache/ephemeral-keys/keys.json`.
 *
 * What "ephemeral" means per vendor (see RESEARCH.md for the why):
 *   OpenAI realtime  — /v1/realtime/client_secrets, ek_… scoped to the session
 *                      config (model). 20-min TTL honored (max 2 h).
 *   OpenAI REST      — NO ephemeral mechanism exists (TTS + chat). Recorded as
 *                      unavailable, not faked.
 *   Gemini Live      — /v1alpha/auth_tokens, model-locked, 20-min expireTime.
 *   ElevenLabs STT   — /v1/single-use-token/realtime_scribe, single-use, TTL
 *                      fixed at 15 min by the vendor (the 20-min target can't be
 *                      met here — the ceiling is 15).
 */

import {
  ELEVENLABS_MODEL,
  mintElevenLabsScribe,
  mintGeminiLive,
  mintOpenAiRealtime,
} from "./mint-core.ts";
import {
  DEFAULT_TTL_SECONDS,
  KEYS_FILE,
  type KeysFile,
  type MintedKey,
  type UnavailableSurface,
} from "./spec.ts";
import { color, fail, heading, info, ok, redact, saveKeysFile, warn } from "./util.ts";

/** The 20-minute session window for Gemini; new-session window stays short. */
const GEMINI_NEW_SESSION_SECONDS = 120;

async function mintOne(label: string, fn: () => Promise<MintedKey>): Promise<MintedKey | null> {
  try {
    const key = await fn();
    ok(
      `${label} → ${redact(key.token)}  ` +
        color.dim(
          `[${key.scopedModels.join(", ")}]  ttl=${Math.round(key.ttlSeconds / 60)}m  exp=${key.expiresAt}`,
        ),
    );
    if (key.note) info(key.note);
    return key;
  } catch (e) {
    fail(`${label} — ${(e as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  heading("Minting ephemeral keys (20-minute target, scoped to channel models/APIs)");

  const results = await Promise.all([
    mintOne("openai · realtime-linter (gpt-realtime-2)", () =>
      mintOpenAiRealtime("linter", DEFAULT_TTL_SECONDS),
    ),
    mintOne("openai · realtime-transcription (gpt-realtime-whisper)", () =>
      mintOpenAiRealtime("transcription", DEFAULT_TTL_SECONDS),
    ),
    mintOne("gemini · live (gemini-3.1-flash-live-preview)", () =>
      mintGeminiLive(DEFAULT_TTL_SECONDS, GEMINI_NEW_SESSION_SECONDS),
    ),
    mintOne(`elevenlabs · stt-realtime (${ELEVENLABS_MODEL})`, () => mintElevenLabsScribe()),
  ]);

  const keys = results.filter((k): k is MintedKey => k !== null);

  // Surfaces with no vendor ephemeral mechanism — recorded honestly, not hidden.
  const unavailable: UnavailableSurface[] = [
    {
      vendor: "openai",
      surface: "rest-tts (/v1/audio/speech · gpt-4o-mini-tts)",
      reason:
        "OpenAI ephemeral (ek_) tokens are realtime-only; project API keys have no TTL. " +
        "Short-lived scoped REST access would need an org Admin key + service accounts + " +
        "project model_permissions, self-deleted on a timer (no auto-expiry).",
    },
    {
      vendor: "openai",
      surface: "rest-chat (/v1/chat/completions · gpt-4o-mini)",
      reason: "Same as rest-tts — no ephemeral credential for REST endpoints.",
    },
  ];

  const file: KeysFile = { createdAt: new Date().toISOString(), keys, unavailable };
  saveKeysFile(file);

  heading("Recorded as UNAVAILABLE (no vendor ephemeral option)");
  for (const u of unavailable) warn(`${u.vendor} · ${u.surface}`);

  heading("Result");
  info(`minted ${keys.length}/4 ephemeral credentials`);
  ok(`wrote ${KEYS_FILE} (mode 0600)`);
  if (keys.length < 4) warn("some mints failed — see above; re-run after checking the parent keys");
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
