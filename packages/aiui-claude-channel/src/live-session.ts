/**
 * The realtime-submode vendor seam.
 *
 * Where {@link ./realtime}'s STT session and {@link ./realtime-voice}'s flagship
 * voice session each speak one vendor's dialect directly, the *realtime submode*
 * (transcription-and-realtime-submodes.md) can run on either **Gemini Live** (the
 * reference engine — hears the mic, sees labeled shots and ~1 fps video, and
 * **composes the prompt itself** via a `submit_intent` function call) or, degraded,
 * **OpenAI realtime** (labeled shots only, no video). So both hide behind one
 * interface the realtime processor drives; the vendor differences (audio rate,
 * image-injection grade, the manual-window ordering rule) live inside each engine.
 *
 * The shape mirrors the house pattern: an injectable socket factory (see
 * {@link ./realtime}.RealtimeSocketFactory) means the unit tests drive a scripted
 * fake session with no network and no key, exactly like realtime.test.ts /
 * realtime-voice.test.ts. Handlers are constructor callbacks
 * ({@link LiveSessionCallbacks}); the processor feeds what comes back into the same
 * append-only chronicle it maintains for transcription mode, so the trace debugger,
 * the turn store, and the fallback compiler (§4.3) all keep working unchanged.
 *
 * The one asymmetry worth stating: the model, not `composeIntent`, is the compiler.
 * The user talks and shares; when the human commits the thread (Enter → fin) the
 * channel injects {@link LIVE_NUDGE_TEXT} — the commit sentinel — and the model
 * answers it with `submit_intent({ segments: [{text?, image?, selection?}] })`:
 * cleaned-up prose interleaved with bare image and selection ids, whose withheld
 * metadata (shot paths/elements, full selection text) the channel re-attaches as
 * it resolves each ref (the live model never sees paths or element info, and only
 * a clipped selection excerpt). The interface exposes exactly the acts the
 * processor needs to make that happen and nothing more.
 */
import type { CallCost } from "./cost";

/**
 * The **commit sentinel** — the client-originated text the channel injects into
 * the conversation when the human commits the thread (Enter → fin), and the
 * ONLY authorized trigger for `submit_intent`: {@link LIVE_COMPOSER_INSTRUCTIONS}
 * quotes it verbatim and forbids calling the tool before it arrives (decided
 * July 2026 — transcription-and-realtime-submodes.md §11). On the wire it is a
 * bare, immediately-answered turn; the single source of truth both engines send
 * and the processor records on its `live nudge` trace stage, so the trace shows
 * exactly what the model was told.
 */
export const LIVE_NUDGE_TEXT =
  "The user pressed send — call submit_intent now with what you have. No further questions.";

/**
 * The composer persona — the one authoritative system-instruction text, shared
 * by both engines (gemini-live and openai-live default to it). It describes the
 * actual situation: a human and the model jointly composing an instruction for a
 * coding agent — voice dictation, labeled screenshots, on-screen context — and it
 * embeds {@link LIVE_NUDGE_TEXT} verbatim so the commit gate can never drift from
 * the message that springs it. Kept terse — instructions are billed as input
 * tokens on every turn.
 */
export const LIVE_COMPOSER_INSTRUCTIONS =
  "You and a human are jointly composing an instruction for a coding agent. The human dictates " +
  "by voice — fragmentary, self-corrected — and shares screenshots and on-screen context as " +
  "they go; images arrive labeled with bracketed ids like [image shot_3], and selections as " +
  "bracketed text items like [selection sel_2: …] (an updated selection reuses its id; a " +
  "retracted one must be disregarded). Build an accurate " +
  'picture of what they want done: resolve deictic references ("this slider", "here") against ' +
  "what you have seen, fold in corrections, drop rambling. Speak briefly — clarify and answer " +
  "in one short sentence. Your final message is the composed instruction: call submit_intent " +
  "with segments[] interleaving the clear, cleaned-up instruction text with bare image and " +
  'selection ids (e.g. "shot_3", "sel_2", "code_1") placed where each belongs — a brief, not ' +
  "a transcript. Call " +
  `submit_intent ONLY after the exact client message "${LIVE_NUDGE_TEXT}" arrives — it is ` +
  "sent when the human commits. Never call it earlier, even if asked aloud to send.";

/**
 * What one vendor's realtime engine can do, read by the processor (and, later,
 * relayed to the client) so nothing hardcodes a vendor. Gemini:
 * `{ video: true, imageInjection: "stream" }`; OpenAI:
 * `{ video: false, imageInjection: "turn-item" }`.
 */
export interface LiveCapabilities {
  /** Whether ambient ~1 fps video frames are accepted (Gemini yes, OpenAI no). */
  video: boolean;
  /**
   * How a labeled shot is injected: Gemini rides one realtime stream
   * (`"stream"`); OpenAI injects a turn-boundary `conversation.item`
   * (`"turn-item"`). The processor need not branch on this — it calls
   * {@link LiveSession.injectLabeledImage} either way — but the descriptor is
   * the honest record of *how* the model came to see an image.
   */
  imageInjection: "stream" | "turn-item";
}

/**
 * The model's compilation result: `submit_intent`'s interleaved segments plus the
 * means to acknowledge the tool call. `text`, `image`, and `selection` are mutually
 * exclusive per segment (the model emits exactly one); `image` is a **bare marker**
 * (`"shot_3"`) the channel resolves back to a rendered `<screenshot>` block, and
 * `selection` a bare selection marker (`"sel_2"` / `"code_1"`) resolved back to the
 * full selection rendering (the same short/long rule `composeIntent` uses).
 */
export interface SubmitIntentCall {
  segments: Array<{ text?: string; image?: string; selection?: string }>;
  /** Send the tool response upstream (Gemini `toolResponse` / OpenAI `function_call_output`). */
  respond(ok: boolean): void;
}

/**
 * How a live session reports back. Everything the processor folds into its
 * chronicle (transcripts), plays to the human (reply audio), or accounts (usage)
 * arrives through these — the analogue of {@link ./realtime}.RealtimeCallbacks,
 * but a conversation, not a transcription stream.
 */
export interface LiveSessionCallbacks {
  /** A finalized *user* utterance transcript — feeds the chronicle + the preview. */
  onUserTranscript(text: string): void;
  /** A finalized *model* reply transcript — what the human was told (a note, never the IR). */
  onReplyTranscript(text: string): void;
  /** One buffered clip of the model's spoken reply (WAV-wrapped, ready to push as `speech`). */
  onReplyAudio(bytes: Uint8Array, mime: string): void;
  /** Barge-in: the model's in-flight reply was interrupted (drop any local playback). */
  onInterrupted(): void;
  /** What one turn/response cost, already priced against the engine's provider. */
  onUsage(cost: CallCost): void;
  /** A failure — surfaced loudly (the keyless/degraded posture the other seams use). */
  onError(message: string): void;
  /**
   * The connection is being asked to wind down within `msLeft` (Gemini `GoAway`);
   * the session budget meter turns amber. Optional — OpenAI has no equivalent.
   */
  onGoAway?(msLeft: number): void;
}

/**
 * One vendor-agnostic live conversational session. The processor opens it at
 * thread-open, drives it as events arrive, and at `fin` runs the ladder:
 * {@link nudgeSubmit} then {@link drainToolCall}.
 */
export interface LiveSession {
  readonly capabilities: LiveCapabilities;
  /** A talk window opens (Gemini `activityStart`; OpenAI implicit). */
  activityStart(): void;
  /** One PCM16 mono frame at the *client* rate (24 kHz) — the engine adapts per vendor. */
  appendAudio(pcm24k: Uint8Array): void;
  /** The talk window closes; the model may now respond (Gemini `activityEnd`; OpenAI commit + response). */
  activityEnd(): void;
  /** Inject a deliberate shot the model can reference by `label` (`shot_3`). */
  injectLabeledImage(label: string, bytes: Uint8Array, mime: string): void;
  /** One ambient video frame (no-op where `!capabilities.video`). */
  appendVideoFrame(bytes: Uint8Array, mime: string): void;
  /**
   * Add SILENT conversation context — a text item that does NOT solicit a
   * reply (selection arrivals, updates, retractions — see intent-v1's
   * realtime intake). OpenAI: a bare `conversation.item.create` with
   * `input_text` and **no** `response.create` (items never auto-trigger a
   * response). Gemini: `clientContent` with `turnComplete: false` — the
   * incremental context append; `realtimeInput.text` would be answered
   * immediately (spike finding 4), which a selection must never provoke.
   */
  injectContextText(text: string): void;
  /**
   * Send {@link LIVE_NUDGE_TEXT} — the commit sentinel, injected at fin. Per
   * {@link LIVE_COMPOSER_INSTRUCTIONS} it is the only message that authorizes
   * `submit_intent`.
   */
  nudgeSubmit(): void;
  /**
   * Resolve with the model's `submit_intent` call, or `null` if none arrives
   * within `timeoutMs` (or the session died) — the ladder's step-3 fallback
   * trigger. A call that arrived before this was awaited is delivered on the
   * next call (buffered), so a fast model never races the drain.
   */
  drainToolCall(timeoutMs: number): Promise<SubmitIntentCall | null>;
  /** Close the upstream socket (idempotent). */
  close(): void;
}
