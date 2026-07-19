/**
 * The `intent-v1` server→client push wire shapes: the three additive messages a
 * lowering processor sends back over the socket out-of-band of the per-frame
 * acks, each distinguished by its `kind` field. Pure types, zero runtime code.
 *
 * These shapes are mirrored by hand on the client side
 * (aiui-intent-runtime/src/protocol.ts — "change both together"), so any edit
 * here is a wire-contract change: keep the two in sync.
 */
import type { IntentEvent, PromptSpan } from "@habemus-papadum/aiui-lowering-pipeline";

/**
 * A server-produced batch of intent events, pushed to the client to merge into
 * its own stream (transcripts it did not compute).
 * Distinguished from a per-frame ack by its `kind` field.
 */
export interface LoweredMessage {
  kind: "lowered";
  threadId: string;
  events: IntentEvent[];
}

/**
 * The turn's final lowered prompt, pushed to the client just before it is sent
 * into the session — exactly what the fin commit hands `sendPrompt`, so a
 * client (a debug viewer, a widget's "what did I just send?" affordance) can
 * show the committed prompt without polling the trace API. Pushed to every
 * client, unconditionally: the push protocol is additive, and old clients
 * ignore unknown kinds by design. A cancelled or empty turn pushes nothing
 * (there is no prompt to show).
 */
export interface LoweredPromptMessage {
  kind: "lowered-prompt";
  threadId: string;
  /** The full composed prompt (context preamble + body), exactly as sent. */
  prompt: string;
  /**
   * Offset-annotated structure over {@link prompt} — the body spans from
   * {@link composeIntent}, shifted past the context preamble, with a leading
   * `preamble` span. A client renders the raw prompt with hover-previews and a
   * de-emphasized preamble from these instead of re-parsing. Additive.
   */
  spans?: PromptSpan[];
  /** The Option-C attachment paths, when the prompt carries `{shot_N}` tokens. */
  meta?: Record<string, string>;
}

/**
 * A base64 audio clip pushed to the client to play — the `premium` tier's spoken
 * TTS ack and the `flagship` tier's model reply share this one additive message
 * (archive/streaming-turns.md §4, archive/model-tiers.md T2/T3). Distinguished from a per-frame
 * ack and a {@link LoweredMessage} by its `kind`. `label` (when present) is the
 * spoken text, for the widget's speaker line and the trace.
 */
export interface SpeechMessage {
  kind: "speech";
  threadId: string;
  /** A per-thread clip/stream id (`ack_N` / `lint_N` / `oracle_N`), for the client player. */
  id: string;
  /**
   * MIME of the payload. Whole clips (TTS acks): a container (`audio/mpeg`).
   * Streamed reply chunks: raw `audio/pcm;rate=24000` — `seq` is present and
   * the client schedules each chunk for gapless playback as it arrives.
   */
  mime: string;
  /** Base64-encoded audio bytes. */
  data: string;
  /**
   * Present ⇒ this is one CHUNK of a streamed reply (0-based, in order,
   * sharing `id` with its siblings). Absent ⇒ a whole clip, played as before.
   * Streaming playback is the contract for model replies (whole-clip
   * buffering retired 2026-07-19 — it delayed the first audible byte by the
   * entire reply's generation time).
   */
  seq?: number;
  /** The spoken text, when known (the widget shows it; the trace records it). */
  label?: string;
}

/**
 * Stop playing a streamed reply NOW — the server-side barge-in echo (Gemini's
 * own VAD interruption; anything the client did not itself initiate). Chunks
 * already forwarded cannot be un-sent; this tells the player to drop what it
 * has scheduled for `id` and play nothing further of it.
 */
export interface SpeechCancelMessage {
  kind: "speech-cancel";
  threadId: string;
  id: string;
}
