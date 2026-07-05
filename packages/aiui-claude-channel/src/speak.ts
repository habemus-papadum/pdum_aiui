/**
 * The text-to-speech seam — server-side, where the OpenAI key belongs. The
 * spoken sibling of {@link ./transcribe}'s `Transcriber`: text in, timed audio
 * bytes out.
 *
 * This backs the `premium` tier's **audio-back acks** (streaming-turns.md §4,
 * model-tiers.md T2): short spoken confirmations ("sent") the channel synthesizes
 * on a lowering milestone and pushes to the page as a base64 `speech` message.
 * Text stays the single source of truth for the agent; audio is a courtesy
 * channel for the human's ears so they can keep looking at the app.
 *
 *  - {@link mockSpeaker} — no network, no key: returns a tiny deterministic byte
 *    blob. The offline/test path (and the explicit degraded stand-in).
 *  - {@link openaiSpeaker} — POSTs to OpenAI's REST TTS (`/v1/audio/speech`,
 *    `gpt-4o-mini-tts`). A one-sentence ack is a few KB; no session to hold, no
 *    per-minute billing (the reason acks use REST TTS, not the realtime model).
 *
 * `fetch` is injected so tests exercise the real request shape without a network
 * (same seam pattern as `transcribe.ts`).
 */

import type { FetchLike } from "./transcribe";

/** One synthesized clip: the audio bytes plus how long, which model, and its MIME. */
export interface SpeechResult {
  bytes: Uint8Array;
  /** Container MIME of {@link bytes} (e.g. `audio/mp3`) — the page player reads it. */
  mime: string;
  latencyMs: number;
  model: string;
}

/** A short line to speak, and an optional voice id. */
export interface SpeakInput {
  text: string;
  /** Voice id (e.g. `alloy`, `cedar`); undefined → the model default. */
  voice?: string;
}

/** Turns a short line of text into spoken audio. */
export interface Speaker {
  readonly name: string;
  speak(input: SpeakInput): Promise<SpeechResult>;
}

/**
 * Local, deterministic speaker: no key, no network. Returns a tiny fixed byte
 * blob (a stand-in "clip") so the ack path round-trips offline in tests — the
 * bytes are not real audio, only a shape to carry through the `speech` message.
 */
export function mockSpeaker(): Speaker {
  return {
    name: "mock",
    async speak({ text }) {
      const started = performance.now();
      // A deterministic, text-derived byte blob (never empty) — enough to prove
      // the message round-trips; not decodable audio.
      const bytes = new TextEncoder().encode(`mock-tts:${text}`);
      return { bytes, mime: "audio/mpeg", latencyMs: performance.now() - started, model: "mock" };
    },
  };
}

export interface OpenAiSpeakerOptions {
  /** Resolves the TTS model at call time (e.g. `gpt-4o-mini-tts`). */
  model: () => string;
  /** The OpenAI API key. */
  apiKey: string;
  /** Injected fetch (defaults to the global). */
  fetch?: FetchLike;
  /** Override the endpoint (tests). */
  baseUrl?: string;
  /** Audio container to request (default `mp3`). */
  format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}

/** The response_format → MIME the page player uses for the `<audio>` `src`. */
const MIME_FOR_FORMAT: Record<string, string> = {
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

/** Real TTS against OpenAI's REST speech endpoint (chunked audio bytes back). */
export function openaiSpeaker(options: OpenAiSpeakerOptions): Speaker {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.openai.com";
  const format = options.format ?? "mp3";
  return {
    name: "openai",
    async speak({ text, voice }) {
      const started = performance.now();
      const model = options.model();
      const res = await doFetch(`${baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: text,
          // OpenAI requires a voice; default to a stable one when unset.
          voice: voice ?? "alloy",
          response_format: format,
        }),
      });
      if (!res.ok) {
        // Errors come back as JSON even though a success is binary audio.
        let message = `speech synthesis failed (${res.status})`;
        try {
          const payload = (await res.json()) as { error?: { message?: string } };
          if (payload.error?.message) {
            message = payload.error.message;
          }
        } catch {
          // non-JSON error body — keep the status message
        }
        throw new Error(message);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        bytes,
        mime: MIME_FOR_FORMAT[format] ?? "audio/mpeg",
        latencyMs: performance.now() - started,
        model,
      };
    },
  };
}
