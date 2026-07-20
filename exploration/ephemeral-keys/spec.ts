/**
 * Shared, firmly-known surface spec for the ephemeral-key exploration.
 *
 * This encodes ONLY the facts derived directly from the channel source
 * (`packages/aiui-claude-channel/src`): which vendor, which parent-key env var,
 * which endpoints + models the channel actually calls, and how each vendor
 * authenticates. The ephemeral-minting details (how to get a short-lived,
 * scoped credential from each parent key) live in `mint.ts`, which is informed
 * by the per-vendor research.
 *
 * The three vendors and their channel usage:
 *
 *  OpenAI     (Bearer header)     REST TTS   POST /v1/audio/speech         gpt-4o-mini-tts
 *                                 REST chat  POST /v1/chat/completions     gpt-4o-mini
 *                                 Realtime   wss  /v1/realtime             gpt-realtime-whisper, gpt-realtime-2
 *  Gemini     (?key= query)       Live WS    BidiGenerateContent           gemini-3.1-flash-live-preview
 *  ElevenLabs (xi-api-key header) Realtime   wss  /v1/speech-to-text/realtime  scribe_v2_realtime
 *
 * NB the Anthropic key is NOT a channel credential — it belongs to the `claude`
 * CLI the channel injects into, so it is out of scope here.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type VendorId = "openai" | "gemini" | "elevenlabs";

export type AuthStyle =
  | { kind: "bearer" } // Authorization: Bearer <key>
  | { kind: "header"; name: string } // <name>: <key>
  | { kind: "query"; param: string }; // ...?<param>=<key>

export interface Surface {
  /** Human label for logs. */
  label: string;
  /** "rest" (HTTP) or "ws" (WebSocket). */
  transport: "rest" | "ws";
  /** Fully-qualified URL of the endpoint. */
  url: string;
  /** Model id(s) the channel pins on this surface. */
  models: string[];
}

export interface VendorSpec {
  id: VendorId;
  label: string;
  /** Env var holding the long-lived PARENT credential used to mint from. */
  parentEnv: string;
  /** How the channel presents a credential to this vendor's endpoints. */
  auth: AuthStyle;
  /** The endpoints/models the channel actually uses (what we scope + test). */
  surfaces: Surface[];
}

export const VENDORS: Record<VendorId, VendorSpec> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    parentEnv: "OPENAI_API_KEY",
    auth: { kind: "bearer" },
    surfaces: [
      {
        label: "TTS (acks)",
        transport: "rest",
        url: "https://api.openai.com/v1/audio/speech",
        models: ["gpt-4o-mini-tts"],
      },
      {
        label: "chat (summarize)",
        transport: "rest",
        url: "https://api.openai.com/v1/chat/completions",
        models: ["gpt-4o-mini"],
      },
      {
        label: "realtime (transcribe + linter)",
        transport: "ws",
        url: "wss://api.openai.com/v1/realtime",
        models: ["gpt-realtime-whisper", "gpt-realtime-2"],
      },
    ],
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    parentEnv: "GEMINI_API_KEY",
    auth: { kind: "query", param: "key" },
    surfaces: [
      {
        label: "Live (linter + oracle)",
        transport: "ws",
        url: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
        models: ["gemini-3.1-flash-live-preview"],
      },
    ],
  },
  elevenlabs: {
    id: "elevenlabs",
    label: "ElevenLabs",
    parentEnv: "ELEVEN_LABS_API_KEY",
    auth: { kind: "header", name: "xi-api-key" },
    surfaces: [
      {
        label: "Scribe v2 realtime STT",
        transport: "ws",
        url: "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
        models: ["scribe_v2_realtime"],
      },
    ],
  },
};

/** Default lifetime for a minted ephemeral key: 20 minutes. */
export const DEFAULT_TTL_SECONDS = 20 * 60;

/** Repo root (worktree root) — this file is exploration/ephemeral-keys/spec.ts. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Where minted keys are cached. `.aiui-cache/` is the project-local, gitignored
 * cache the rest of the toolchain uses; we add an `ephemeral-keys/` subdir.
 */
export const CACHE_DIR = resolve(REPO_ROOT, ".aiui-cache", "ephemeral-keys");

/** The single file the mint command writes and the test command reads. */
export const KEYS_FILE = resolve(CACHE_DIR, "keys.json");

/** One minted ephemeral credential, as persisted to the cache file. */
export interface MintedKey {
  vendor: VendorId;
  /** Which channel surface this key is for (a vendor may need >1, e.g. OpenAI). */
  surface: string;
  /** The ephemeral token/secret string. */
  token: string;
  /** How the token is presented to the endpoint (may differ from the parent!). */
  auth: AuthStyle;
  /** ISO timestamp when minted. */
  mintedAt: string;
  /** ISO timestamp when it expires (best-effort; some vendors don't echo this). */
  expiresAt: string | null;
  /** Requested TTL in seconds. */
  ttlSeconds: number;
  /** Models the token is scoped to (if the vendor supports pinning). */
  scopedModels: string[];
  /** True when the token is spent after a single use (ElevenLabs). */
  singleUse?: boolean;
  /** Anything notable (e.g. "15-min cap, not 20"). */
  note?: string;
  /** Free-form vendor detail (raw mint response fields worth keeping). */
  detail?: Record<string, unknown>;
}

/** A channel surface for which NO ephemeral credential is obtainable. */
export interface UnavailableSurface {
  vendor: VendorId;
  surface: string;
  /** Why there is no ephemeral option here. */
  reason: string;
}

/** The whole cache file. */
export interface KeysFile {
  createdAt: string;
  keys: MintedKey[];
  /** Surfaces we deliberately could NOT mint for (recorded, not hidden). */
  unavailable: UnavailableSurface[];
}
