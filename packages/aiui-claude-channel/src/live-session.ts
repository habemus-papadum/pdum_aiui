/**
 * The prompt-LINTER vendor seam.
 *
 * Where {@link ./realtime}'s STT session speaks one vendor's dialect
 * directly, the prompt linter (docs/guide/prompt-linting.md) can run on
 * either **Gemini Live** (video-capable, the reference) or **OpenAI
 * realtime** (frames as turn-boundary items). Both hide behind one interface
 * the linter sidecar drives; the vendor differences (audio rate, image
 * injection grade, the manual-window ordering rule, the tool resume rule)
 * live inside each engine.
 *
 * The shape mirrors the house pattern: an injectable socket factory (see
 * {@link ./realtime}.RealtimeSocketFactory) means the unit tests drive a
 * scripted fake session with no network and no key. Handlers are constructor
 * callbacks ({@link LiveSessionCallbacks}); the sidecar feeds what comes back
 * into the same append-only chronicle the processor maintains, so the trace
 * debugger, the turn store, and the compiler all keep working unchanged.
 *
 * The invariant worth stating: the model NEVER composes. The compiler
 * (`composeIntent`) assembles the prompt in every configuration; a live
 * session only observes the turn and speaks short diagnostics. (The
 * composer-era `submit_intent` machinery — the nudge sentinel, the tool
 * drain — was deleted with the model-composes submode; see
 * archive/realtime_pivot_plan.md.)
 */
import type { CallCost } from "./cost";

/**
 * The **prompt-linter persona** — the authoritative system-instruction text for
 * linter-mode sessions, shared by both engines. Published VERBATIM in
 * docs/guide/prompt-linting.md (the "every prompt is documented" principle) —
 * edits here must be mirrored there. Overridable per-hello via
 * `linterInstructions`. Kept terse — instructions are billed as input tokens
 * on every turn.
 */
export const LINTER_INSTRUCTIONS =
  "You are a realtime prompt linter. You are observing a person compose a task briefing for a " +
  "coding agent, out loud: you hear their voice, you see their screen, and you receive labeled " +
  "screenshots ([image shot_3]) and on-screen selections ([selection sel_2: …]; an updated " +
  "selection reuses its id, a retracted one must be disregarded). Bracketed " +
  '[transcript seg_N: "…"] messages show the exact transcription the compiler will use — ' +
  "reconcile each against what you heard. You never write or rewrite the briefing — a separate " +
  "compiler assembles it verbatim from what they said and attached. You speak ONLY when asked: " +
  "the human explicitly requests your read, and your turn covers everything accumulated since " +
  "your last one. Respond with a few short spoken sentences carrying the most useful " +
  "observations: a transcription that contradicts what they plainly meant (say what was " +
  "transcribed vs. meant — the human can only fix it by saying it again more clearly); an " +
  'ambiguous reference an agent could not resolve ("this slider" — two sliders were ' +
  "discussed); something described but never shown (suggest a screenshot) or shown but never " +
  "explained; a missing constraint an agent would need. If nothing needs attention, say only " +
  '"clear so far". Never summarize, never repeat the briefing back, never answer the task ' +
  "yourself. You may call read_file to check a file or selection against the actual source " +
  "before flagging it — verify suspicions, don't browse.";

/**
 * What one vendor's realtime engine can do, read by the processor (and, later,
 * relayed to the client) so nothing hardcodes a vendor. Gemini:
 * `{ video: true, imageInjection: "stream" }`; OpenAI:
 * `{ video: true, imageInjection: "turn-item" }`.
 */
export interface LiveCapabilities {
  /** Whether ambient video frames are accepted (both vendors: yes). */
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
 * A linter tool call (e.g. `read_file`): the caller answers with a RESULT
 * string the model reads before resuming. `respond` carries the vendor
 * resume rule internally: Gemini resumes automatically on `toolResponse`;
 * OpenAI needs `function_call_output` **then** `response.create` (a written
 * tool result never re-triggers the response on its own).
 */
export interface LinterToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** Deliver the tool's result (content or an error string the model can read). */
  respond(result: string): void;
}

/**
 * How a live session reports back. Everything the processor folds into its
 * chronicle (transcripts), plays to the human (reply audio), or accounts (usage)
 * arrives through these — the analogue of {@link ./realtime}.RealtimeCallbacks,
 * but a conversation, not a transcription stream.
 */
export interface LiveSessionCallbacks {
  /** A finalized *model* reply transcript — the linter's note. (There is no
   * user-transcript callback: linter sessions run without vendor input
   * transcription — the STT session owns the chronicle.) */
  onReplyTranscript(text: string): void;
  /**
   * One PCM chunk of the model's spoken reply, forwarded the MOMENT the
   * vendor streams it (raw PCM16 mono — `mime` is `audio/pcm;rate=24000`,
   * both vendors). Streaming playback is the contract: the receiver pushes
   * chunked `speech` frames and the client plays as they arrive — the
   * whole-clip WAV buffering (which delayed the first audible byte by the
   * entire reply's generation) was retired 2026-07-19.
   */
  onReplyAudio(bytes: Uint8Array, mime: string): void;
  /** Barge-in: the model's in-flight reply was interrupted (drop any local playback). */
  onInterrupted(): void;
  /** What one turn/response cost, already priced against the engine's provider. */
  onUsage(cost: CallCost): void;
  /**
   * A failure — surfaced loudly (the keyless/degraded posture the other seams
   * use). `data` optionally carries the structured upstream payload (the API's
   * error object, a close code + reason) for the client's details expander —
   * the human should get to read what the API actually said.
   */
  onError(message: string, data?: unknown): void;
  /**
   * The connection is being asked to wind down within `msLeft` (Gemini `GoAway`);
   * the session budget meter turns amber. Optional — OpenAI has no equivalent.
   */
  onGoAway?(msLeft: number): void;
  /**
   * A linter-mode tool call arrived (e.g. `read_file`). The receiver executes
   * the tool and calls {@link LinterToolCall.respond} with the result; the
   * engine handles the vendor's resume rule. Optional — a caller that wires
   * no tools simply never hears from it.
   */
  onToolCall?(call: LinterToolCall): void;
  /**
   * The model's turn finished — the reply is complete (or was cancelled) and
   * the floor is free. OpenAI: `response.done` whose output holds no
   * `function_call` (a tool-call turn is NOT complete — the resumed response
   * after the tool result fires its own `response.done`). Gemini:
   * `serverContent.turnComplete` — for parity. The concrete "the model is
   * done" signal the CONVERSE turn strategy's after-reply policy keys on
   * (docs/proposals/capture-bus-and-consumers.md §3); overhear callers may
   * ignore it. Optional.
   */
  onTurnComplete?(): void;
  /**
   * The vendor's own transcription of the HUMAN's input audio — the
   * `oracle-heard` record (capture-bus §8 decision 6). Only fires when the
   * session enabled input transcription (the oracle does; the linter and STT
   * deliberately do not — the STT session owns the chronicle there). Optional.
   */
  onInputTranscript?(text: string): void;
}

/**
 * One vendor-agnostic live conversational session. The linter sidecar opens
 * it at thread-open, drives it as events arrive, and closes it at fin.
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
   * Barge-in from our side: cancel the model's in-flight response (the human
   * started talking over the lint). OpenAI sends `response.cancel`; Gemini
   * has no client-side cancel (its own VAD-free barge-in is the interrupted
   * signal), so it is a no-op there.
   */
  cancelActiveResponse(): void;
  /** Close the upstream socket (idempotent). */
  close(): void;
}
