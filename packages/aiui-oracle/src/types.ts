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
  | { kind: "response"; responseId: string; status: string; usage?: UsageTotals }
  | {
      kind: "error";
      source: "vendor" | "transport" | "tool" | "key";
      message: string;
      data?: unknown;
    }
  | { kind: "raw"; type: string; event: Record<string, unknown> };
