/**
 * types.ts — the oracle's shared vocabulary: the session config, the tool
 * shape, the transport seams, and the LEDGER (the normalized, append-only
 * record of everything a session did — the single source every widget and the
 * raw-JSON view render from).
 *
 * Contract of record: docs/proposals/aiui-oracle.md. Two decisions show up
 * structurally here: transports diverge on exactly three seams (input audio,
 * output audio, interrupt) and advertise capability flags rather than faking
 * parity; and unrecognized vendor events are RETAINED as `raw` ledger entries,
 * never dropped (the trace-stages total-parse lesson).
 */

/** A tool the model may call — executed locally, in the page. */
export interface OracleTool {
  /** Vendor-visible name (the model calls this). */
  name: string;
  /** What the model reads to decide when to call it. */
  description: string;
  /** JSON Schema for the arguments. Realtime has NO strict mode — the bridge
   * validates defensively; this schema is advisory to the model. */
  parameters: Record<string, unknown>;
  /**
   * Run the call. The return value is JSON-stringified into the
   * `function_call_output` (a thrown error becomes an `{ error }` output the
   * model can read — the vendor has no error channel for tools).
   */
  execute(args: Record<string, unknown>): unknown | Promise<unknown>;
}

/** Turn control, mapped onto the vendor's `turn_detection`. */
export type OracleTurnMode = "auto" | "semantic" | "manual";

/** The oracle's session configuration (ours, not the wire shape). */
export interface OracleConfig {
  /** Realtime model id. Default {@link DEFAULT_ORACLE_MODEL}. */
  model?: string;
  /** Output voice — IMMUTABLE once the model has spoken; chosen up front.
   * Default {@link DEFAULT_ORACLE_VOICE}. */
  voice?: string;
  /** The woven persona + app-specific prompt. Kept GENERIC about which tools
   * exist — the `tools` array is the single source of truth (the documented
   * "keep tool availability synchronized" failure mode). */
  instructions: string;
  /** The tool surface presented at session start (live-updatable after). */
  tools?: OracleTool[];
  /** Turn control. Default "auto" (`server_vad`, vendor defaults). */
  turn?: OracleTurnMode;
  /**
   * Extra fields merged into the vendor's `turn_detection` object — the VAD's
   * own tuning (`threshold`, `prefix_padding_ms`, `silence_duration_ms`, and
   * whether a detection may interrupt a reply in progress).
   *
   * A passthrough, deliberately untyped beyond `unknown`: these are the
   * vendor's names, not ours, and this repo's rule is to never assume an API
   * param exists — send it and read the server's ECHO. The `config` ledger
   * entry carries `sent` / `effective` / `drift` for exactly that check, so a
   * field the vendor ignores is visible rather than believed.
   *
   * The reason this exists: a voice agent that speaks through the same device
   * it listens on can trigger its own VAD. Echo cancellation is the first
   * defence (see `ECHO_SAFE_AUDIO`); raising the threshold is the second.
   */
  turnTuning?: Record<string, unknown>;
  /**
   * The vendor's INPUT noise reduction — `"near_field"` (a headset) or
   * `"far_field"` (a laptop mic across the room from its own speakers). Sent
   * as `audio.input.noise_reduction`, which is a sibling of `turn_detection`
   * and so cannot ride {@link turnTuning}.
   *
   * `far_field` is the documented speakerphone setting and, with a raised
   * {@link turnTuning} threshold, is what practitioners report fixes a model
   * that barges in on its own voice. Verified the same way as everything else
   * here: sent, then read back off the `session.updated` echo.
   */
  noiseReduction?: "near_field" | "far_field";
  /**
   * Protect the FIRST reply from the microphone's own echo. Default ON; pass
   * `false` to disable, or an object to tune the timings.
   *
   * The problem it solves: a browser's echo canceller is adaptive — it has no
   * model of the room until it has actually heard far-end audio come back
   * through the mic. So the very first reply leaks, the VAD hears "speech",
   * and the session barges in on itself. Which is exactly the reported
   * symptom: it happens on the first interaction and never again.
   *
   * The fix is a window, not a setting: until the first reply has finished
   * speaking, `turn_detection` carries `interrupt_response: false`, so what
   * the mic hears cannot truncate that reply. Then the complete block is
   * re-sent with the configured values, and the session behaves normally for
   * the rest of its life.
   *
   * That field and no other. `create_response: false` also rode here for one
   * commit — to stop the echo being committed as a user turn and generating a
   * reply to its own voice — and it deadlocked the session MUTE: the window
   * closes when a reply happens, so suppressing reply creation means the
   * human's first utterance never makes one, `response.created` never fires,
   * the cap never starts, and no exit can ever be reached. Anything added
   * here must leave the session able to produce the very reply this window
   * waits for.
   *
   * Closing the window needs a real end-of-speech signal, and `response.done`
   * is not one (the transcript finishes seconds ahead of the audio, and on
   * WebRTC the reply is a track we cannot time). {@link LedgerBody}'s
   * `reply-audio` entry is that signal — the vendor's `output_audio_buffer.*`
   * events, which this package used to discard as chatter.
   */
  firstReplyGuard?: boolean | FirstReplyGuard;
  /** Vendor-side transcription of the USER's audio (the "heard" record).
   * Default on; costs transcription tokens. */
  transcribeInput?: boolean;
  /**
   * TTL for a minted ephemeral secret, seconds (10–7200). Default 600.
   *
   * NOT read by {@link OracleSession} — and structurally cannot be: the
   * session never mints, it asks a {@link KeySource}. TTL belongs to whoever
   * holds the parent key, which is `mintClientSecret`'s `MintOptions` for an
   * in-browser mint and the mint SERVER's own option for a hosted one (the
   * channel sets it on `createMintBackend`). Kept as documentation of the
   * knob's existence and its range; a session-level value would be a lie
   * about who decides.
   */
  mintTtlSeconds?: number;
}

/** Timings for {@link OracleConfig.firstReplyGuard}. */
export interface FirstReplyGuard {
  /**
   * Grace after the reply's audio stops before interrupts are armed, ms.
   * Default {@link DEFAULT_FIRST_REPLY_PAD_MS}.
   *
   * `output_audio_buffer.stopped` means the SERVER finished sending; the
   * client's jitter buffer may still have a few hundred milliseconds to play,
   * and that tail is echo like any other.
   */
  padMs?: number;
  /**
   * Hard cap from the first response's creation, ms. Default
   * {@link DEFAULT_FIRST_REPLY_MAX_MS}.
   *
   * The end-of-audio event is undocumented (community-verified only) and has
   * been reported to arrive late, so it never gets to be the ONLY way out of
   * the window — a reply that produces no audio at all, or an event that
   * simply never comes, must not leave barge-in disabled for the session.
   * Arming late is harmless: echo cancellation converges within a second or
   * two of far-end audio, so by the cap the hazard is long past.
   */
  maxMs?: number;
}

export const DEFAULT_FIRST_REPLY_PAD_MS = 400;
export const DEFAULT_FIRST_REPLY_MAX_MS = 15_000;

export const DEFAULT_ORACLE_MODEL = "gpt-realtime-2.1";
export const DEFAULT_ORACLE_VOICE = "marin";
export const DEFAULT_INPUT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

/** A short-lived credential for opening realtime sessions. One `ek_` mints
 * MULTIPLE sessions until it expires — reconnects reuse it within TTL. */
export interface OracleCredential {
  ek: string;
  /** Unix seconds; 0 = unknown (a pasted `ek_` we didn't mint). */
  expiresAt: number;
  /** Which source answered (paste-key / dev-key / mint:URL) — the ledger's
   * auth attribution. */
  source?: string;
}

/** Where credentials come from — the pluggable auth seam. */
export interface KeySource {
  /** Human-readable, for the ledger ("paste-key", "mint:https://…"). */
  describe(): string;
  /**
   * Produce a session-opening credential for the given wire session config.
   * (The baked config is a DEFAULT, not a sandbox — the client can
   * `session.update` over it; TTL is the real bound.)
   */
  credential(session: Record<string, unknown>): Promise<OracleCredential>;
}

/** What a transport can and cannot do — read by widgets so a missing feature
 * is visibly absent, never silently broken. */
export interface TransportCapabilities {
  /** Reply audio available as PCM data events (WS yes; WebRTC no — track only). */
  replyAudioData: boolean;
  /** Barge-in handled server-side (WebRTC yes; WS = client bookkeeping). */
  serverBargeIn: boolean;
  /** `input_audio_buffer.append` is a documented input path (WS yes). */
  injectAudio: boolean;
  /** Exposes a call id a sideband participant can join (WebRTC yes). */
  sideband: boolean;
}

/** What the engine hands a transport at connect time. */
export interface TransportConnectOptions {
  credential: OracleCredential;
  /** The vendor wire session config to bake at mint/connect time. */
  session: Record<string, unknown>;
  /** Every decoded vendor event (server → client), in arrival order. */
  onEvent(event: Record<string, unknown>): void;
  /** Transport-level lifecycle faults (socket close, ICE failure…). */
  onClose(reason: string): void;
  /** Reply playback was blocked by autoplay policy (needs a user gesture). */
  onPlaybackBlocked?(): void;
  /** Reuse this element for reply audio instead of creating one. */
  audioElement?: HTMLAudioElement;
}

/** A live connection. The three divergent seams live here; everything else is
 * `send`. */
export interface TransportHandle {
  /** Send one client event (the engine stamps `event_id` before calling). */
  send(event: Record<string, unknown>): void;
  /** Input-audio seam: gate the mic. `false` is the PARK half — the source
   * keeps producing silence-shaped nothing, the connection stays open, $0. */
  setMicEnabled(on: boolean): void;
  /** Interrupt seam: stop the current reply the transport-appropriate way. */
  interrupt(): void;
  /** Live mic MediaStream (level meters tap this). Undefined pre-connect. */
  readonly micStream?: MediaStream;
  /**
   * What the browser ACTUALLY gave us for the mic — the track's effective
   * settings, not what we asked for.
   *
   * Constraints are requests; a device, an OS setting, or a driver can refuse
   * one silently. For an agent that talks back through the same speakers it
   * listens on, whether echo cancellation is really on is the single fact that
   * explains "it keeps interrupting itself" — and asking after the fact is
   * useless, because the session that misbehaved has closed by then. So it is
   * recorded in the LEDGER at connect, where it stays.
   */
  readonly audioSettings?: () => Record<string, unknown> | undefined;
  /** The vendor call id (WebRTC `Location` header) — the sideband hook. */
  readonly callId?: string;
  close(): void;
}

export interface OracleTransport {
  readonly name: string;
  readonly capabilities: TransportCapabilities;
  connect(options: TransportConnectOptions): Promise<TransportHandle>;
}

// ── the ledger ───────────────────────────────────────────────────────────────

export type OracleStatus = "idle" | "connecting" | "live" | "parked" | "closed" | "error";

/** Token usage tallied from `response.done` payloads. */
export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  responses: number;
}

export type LedgerEntry = { at: number; seq: number } & LedgerBody;

/** The entry payloads, without the stamp — what the engine's `record` takes. */
export type LedgerBody =
  | { kind: "session"; phase: OracleStatus; detail?: string }
  | {
      /** A config we sent + what the server acked (`session.updated` is the
       * reconciliation signal); `drift` names intended-vs-effective gaps. */
      kind: "config";
      sent?: Record<string, unknown>;
      effective?: Record<string, unknown>;
      drift?: string[];
    }
  | { kind: "speech"; phase: "started" | "stopped" }
  /**
   * The REPLY's audio lifecycle — the vendor's `output_audio_buffer.*` events,
   * WebRTC-only and undocumented in the API reference, but the only thing that
   * says when the agent actually stopped talking. `response.done` is not that:
   * the transcript completes seconds ahead of the speech.
   *
   * These were in this package's known-chatter drop list, which made
   * "has it finished speaking?" unanswerable from a record that in fact
   * contained the answer. `cleared` is an interrupt flushing the buffer, and
   * counts as an ending like any other.
   */
  | { kind: "reply-audio"; phase: "started" | "stopped" | "cleared" }
  | { kind: "heard"; text: string }
  | { kind: "said"; responseId: string; text: string }
  | {
      kind: "tool-call";
      callId: string;
      name: string;
      args: string;
      /** `completed` responses execute; `cancelled`/`incomplete` NEVER do —
       * `function_call_arguments.done` fires for those too (research). */
      status: "completed" | "cancelled" | "incomplete";
      /** The gate's measured cost: ms from `function_call_arguments.done` to
       * the `response.done` that authorized (or refused) execution. */
      gateMs?: number;
    }
  | { kind: "tool-result"; callId: string; name: string; ok: boolean; output: string; ms: number }
  | { kind: "injected"; role: "user" | "system"; text?: string; image?: boolean }
  /**
   * A control event WE sent — `response.create`, `response.cancel`, the
   * interrupt pair. The ledger was inbound-only, which left one question
   * unanswerable from the record: when a reply is cancelled, did the vendor
   * do it (a barge-in on detected speech) or did we? Both look identical from
   * the `response.done` side, and "read the code and trust me" is not
   * evidence. Deliberately NOT every outbound event — audio frames and
   * session updates would drown the thing this exists to show.
   */
  | { kind: "sent"; type: string }
  | { kind: "response"; responseId: string; status: string; usage?: UsageTotals }
  | {
      kind: "error";
      source: "vendor" | "transport" | "tool" | "key";
      message: string;
      data?: unknown;
    }
  | { kind: "raw"; type: string; event: Record<string, unknown> };
