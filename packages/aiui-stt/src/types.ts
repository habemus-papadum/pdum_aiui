/**
 * One transcribed word with its position in the SEGMENT'S OWN AUDIO —
 * milliseconds from the segment's first sample — plus the model's confidence
 * when the vendor reports one. Scribe reports timestamps and logprobs.
 */
export interface SttWord {
  text: string;
  startMs?: number;
  endMs?: number;
  logprob?: number;
}

/** One segment's final transcript. */
export interface SttFinal {
  text: string;
  /** Wall-clock from the segment's commit (talk-end) to its terminal event. */
  latencyMs: number;
  model: string;
  /** Per-word timings/confidence when the engine produces them. */
  words?: SttWord[];
}

/**
 * Something the vendor did that the engine did not act on, or acted on in a
 * way worth recording. Purely observational — a diagnostic never changes
 * control flow. They exist because every silent drop in a vendor message
 * switch is a place transcript can vanish without a trace (the former
 * channel's Scribe self-commit post-mortem).
 */
export type SttDiagnostic =
  | { kind: "config-echo"; config: Record<string, unknown> }
  | { kind: "config-mismatch"; param: string; requested: unknown; echoed: unknown }
  | { kind: "vendor-commit"; segment: number; chars: number; words: number }
  | { kind: "orphan-result"; messageType: string; chars: number }
  | { kind: "unhandled"; messageType: string; raw: string };

export interface SttCallbacks {
  /** Terminal connection failure; reconnect needs a fresh credential. */
  onClose?(message: string): void;
  /**
   * A partial transcript for `segment` — CUMULATIVE text, not a raw delta.
   * Every engine re-sends the whole running text, so a partial that gets
   * *shorter* is the vendor revising itself, not data loss. Fires from the
   * moment the model starts transcribing — while the segment's audio is
   * still streaming, before its commit.
   */
  onDelta(segment: number, cumulativeText: string): void;
  /** The final transcript for `segment`. Fires exactly once per committed segment. */
  onFinal(segment: number, result: SttFinal): void;
  /**
   * A failure. `segment` names the committed segment it belongs to (so the
   * caller can settle just that one loudly); undefined for a session-wide
   * fault before any commit.
   */
  onError(message: string, segment?: number): void;
  /** Optional protocol observability — see {@link SttDiagnostic}. */
  onDiagnostic?(event: SttDiagnostic): void;
}

/**
 * A live transcription session:
 * audio streams in by segment ordinal; results come back through the
 * {@link SttCallbacks} handed to {@link SttTransport.open}.
 */
export interface SttConnection {
  /** Resolves on the vendor handshake, rejects on timeout or failed authentication. */
  readonly ready?: Promise<void>;
  /** Append one PCM16 frame of `segment`. */
  appendAudio(segment: number, bytes: Uint8Array): void;
  /** Commit `segment` (talk-end): its buffered audio becomes one transcript. */
  commit(segment: number): void;
  /**
   * Drop `segment` without transcribing it — an accidental tap under the
   * engine's commit floor. Stray frames must never prepend to the next
   * segment's *transcript* (each engine resolves that its own wire-specific
   * way; see the per-engine notes).
   */
  discard(segment: number): void;
  /**
   * Resolve once every committed-but-not-final segment has produced its
   * final, or `timeoutMs` elapses — whichever first. Returns the ordinals
   * still outstanding at timeout, so the caller can settle them loudly.
   */
  drain(timeoutMs: number): Promise<number[]>;
  /** Close the vendor socket (idempotent). */
  close(): void;
}

/** What an engine can and cannot do — read so a missing feature is visibly
 * absent, never silently broken (the oracle's capability discipline). */
export interface SttCapabilities {
  /** Per-word timestamps on finals. */
  wordTimestamps: boolean;
  /** Per-word confidence (both, differently produced). */
  wordLogprobs: boolean;
  /** A language hint is configurable. */
  languageHint: boolean;
  /** Domain keyterm biasing (Scribe: repeatable URL params). */
  keyterms: boolean;
  /** Vendor-side turn detection. False for both in V1 — the client commits. */
  vendorVad: boolean;
}

/**
 * One STT engine flavor. `open` performs the credential act (minting a
 * single-use token, presenting an `ek_`) and connects — so a transport is
 * also the unit of reconnect: one `open` = one credential = one socket.
 */
export interface SttTransport {
  readonly name: string;
  readonly capabilities: SttCapabilities;
  open(callbacks: SttCallbacks): Promise<SttConnection>;
}

export type { AudioSource } from "@habemus-papadum/aiui-audio";

/** The handle's lifecycle state. */
export type SttStatus = "idle" | "connecting" | "ready" | "closed" | "error";

/** The event stream {@link ../reactive}.sttSignals (and any observer) consumes. */
export type SttEvent =
  | { type: "status"; status: SttStatus }
  | { type: "delta"; segment: number; text: string }
  | { type: "final"; segment: number; result: SttFinal }
  | { type: "error"; message: string; segment?: number }
  | { type: "diagnostic"; diagnostic: SttDiagnostic };
