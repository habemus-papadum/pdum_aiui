/**
 * scribe.ts — the ElevenLabs **Scribe v2 realtime** engine, THE DEFAULT: the
 * browser-side port of the channel's `elevenlabs-realtime.ts`, whose wire
 * facts were live-verified and are preserved here verbatim. Auth is the one
 * browser difference: the single-use token already rides the connect URL the
 * injected `connectUrl()` returns (minted per connect — `aiui-cf-creds/stt`'s
 * `scribeConnectUrl`, or a channel mint route), so the socket opens with no
 * headers and no subprotocol.
 *
 * The recorded wire facts this port preserves (see the channel module's
 * post-mortems for the full stories):
 *
 *  - **All config rides the connect URL** (no in-band setup frame); unknown
 *    params are accepted SILENTLY, so the `session_started` config echo is
 *    the only proof a param took effect ({@link checkScribeConfigEcho}).
 *  - **No item ids** — correlation is purely positional (commit-order FIFO);
 *    a terminal frame with no FIFO head belongs to the streaming segment.
 *  - **Scribe commits utterances ITSELF** (~40 s cap on a continuous
 *    utterance, not switchable off) and then resets its partial to empty. A
 *    push-to-talk segment is therefore MANY utterances: self-committed text
 *    accumulates per segment, partials are re-prefixed, and the segment's
 *    final concatenates everything (the alternative silently destroys
 *    transcript — the channel's costliest STT bug).
 *  - **`commit_throttled` is FATAL**: committing with < 0.3 s of uncommitted
 *    audio closes the socket with no recovery, so a local uncommitted-audio
 *    meter gates every commit behind {@link SCRIBE_COMMIT_FLOOR_MS}; an
 *    under-floor commit sends NOTHING and resolves the segment locally.
 *  - **Idle keepalive**: the server closes an idle socket ~15 s after
 *    `session_started`; an empty chunk every {@link SCRIBE_KEEPALIVE_MS}
 *    resets that timer without touching the buffer or timestamp timeline.
 *  - **Word timestamps are session-cumulative**, not per-segment — each
 *    segment records its audio base and {@link convertScribeWords} rebases.
 *  - **`discard` sends nothing** — Scribe has no buffer-clear and committing
 *    the scrap is fatal; the ≤0.3 s stray stays in the vendor buffer.
 */

import {
  browserSocketFactory,
  closeSuffix,
  createDrainController,
  createReadyGate,
  reportSessionFailure,
  type SttSocketFactory,
  toBase64,
} from "./support";
import type { SttCallbacks, SttCapabilities, SttConnection, SttTransport, SttWord } from "./types";

/** The default realtime transcription model (and ElevenLabs' only one today). */
export const DEFAULT_SCRIBE_MODEL = "scribe_v2_realtime";

/** The capture rate; matches `audio_format=pcm_24000` and each chunk's `sample_rate`. */
export const SCRIBE_SAMPLE_RATE = 24000;

/** PCM16 mono at 24 kHz: 48 bytes per ms — the uncommitted-audio meter's unit. */
const BYTES_PER_MS = (SCRIBE_SAMPLE_RATE * 2) / 1000;

/**
 * The local floor, in ms of uncommitted audio, below which a commit is
 * REFUSED (resolved locally, nothing on the wire). Scribe's hard minimum is
 * 300 ms and violating it kills the whole session (`commit_throttled` +
 * socket close); 500 holds a margin because the penalty is total.
 */
export const SCRIBE_COMMIT_FLOOR_MS = 500;

/** Idle keepalive cadence — the server closes an idle socket ~15 s after
 * `session_started`; 10 s leaves margin, and an empty chunk costs nothing. */
export const SCRIBE_KEEPALIVE_MS = 10_000;

/**
 * The `message_type`s Scribe uses to report a fault; all carry an `error`
 * text. {@link isScribeErrorType} also treats any unknown `*error` type as a
 * fault, so a new one degrades to an error rather than silence.
 */
export const SCRIBE_ERROR_TYPES: ReadonlySet<string> = new Set([
  "error",
  "auth_error",
  "quota_exceeded",
  "commit_throttled",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "input_error",
  "chunk_size_exceeded",
  "insufficient_audio_activity",
  "unaccepted_terms",
  "transcriber_error",
]);

export function isScribeErrorType(type: string): boolean {
  return SCRIBE_ERROR_TYPES.has(type) || type.endsWith("error");
}

/**
 * Convert Scribe's timestamped `words[]` into {@link SttWord}s: seconds →
 * integer ms, REBASED by `baseMs` (Scribe's timings live on the session's
 * cumulative audio timeline) and clamped at ≥ 0; `type:"spacing"` filler
 * dropped; `logprob` carried through. Tolerant — a malformed entry
 * contributes nothing rather than throwing.
 */
export function convertScribeWords(raw: unknown, baseMs = 0): SttWord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rebase = (seconds: number): number => Math.max(0, Math.round(seconds * 1000 - baseMs));
  const out: SttWord[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const w = entry as {
      text?: unknown;
      start?: unknown;
      end?: unknown;
      type?: unknown;
      logprob?: unknown;
    };
    if (w.type === "spacing") {
      continue; // filler between words — no lexical content to carry
    }
    out.push({
      text: typeof w.text === "string" ? w.text : "",
      ...(typeof w.start === "number" ? { startMs: rebase(w.start) } : {}),
      ...(typeof w.end === "number" ? { endMs: rebase(w.end) } : {}),
      ...(typeof w.logprob === "number" ? { logprob: w.logprob } : {}),
    });
  }
  return out;
}

/** The params provable from the echo (unknown URL params are accepted silently). */
const ECHOED_PARAMS = ["model_id", "include_timestamps", "no_verbatim"] as const;

/**
 * Diff what we asked for against the `session_started` config echo — the only
 * evidence a connect-URL param exists at all. Reports, never throws.
 */
export function checkScribeConfigEcho(
  requested: Record<string, unknown>,
  echoed: Record<string, unknown> | undefined,
): Array<{ param: string; requested: unknown; echoed: unknown }> {
  if (echoed === undefined) {
    return [];
  }
  const out: Array<{ param: string; requested: unknown; echoed: unknown }> = [];
  for (const param of ECHOED_PARAMS) {
    if (!(param in requested)) {
      continue;
    }
    const want = requested[param];
    const got = echoed[param];
    // The echo is typed (booleans as booleans); the URL is all strings.
    if (String(got) !== String(want)) {
      out.push({ param, requested: want, echoed: got ?? "(absent)" });
    }
  }
  return out;
}

export interface ScribeTransportOptions {
  /**
   * One call = one connect: returns a ready-to-open socket URL with a FRESH
   * single-use token riding the query string (`aiui-cf-creds/stt`'s
   * `scribeConnectUrl`, or a channel mint route). Single-use by construction
   * — there is nowhere to hold a token wrong.
   */
  connectUrl: () => Promise<string>;
  /** ISO-639 language hint (`language_code`); absent → Scribe auto-detects. */
  language?: string;
  /** Domain-bias terms — repeated PLAIN `keyterms` params (the bracket form
   * is silently dropped by the server). */
  keyterms?: readonly string[];
  /** Collapse disfluencies/false-starts (`no_verbatim`). Default `true`. */
  noVerbatim?: boolean;
  /** Override the model on the connect URL (default: what the URL carries,
   * i.e. {@link DEFAULT_SCRIBE_MODEL} from the credential side). */
  modelId?: string;
  /** Injected socket (tests); defaults to the platform WebSocket. */
  socketFactory?: SttSocketFactory;
  /** Injected clock (tests). */
  now?: () => number;
}

export const SCRIBE_CAPABILITIES: SttCapabilities = {
  wordTimestamps: true,
  wordLogprobs: true,
  languageHint: true,
  keyterms: true,
  vendorVad: false,
};

/** One committed segment awaiting its terminal event, in FIFO (commit) order. */
interface CommittedSegment {
  segment: number;
  committedAt: number;
  /** Cumulative audio ms streamed before this segment began — the rebase base. */
  audioBaseMs: number;
}

/** Utterances Scribe closed on its own inside a segment, awaiting that segment's final. */
interface PendingUtterances {
  texts: string[];
  words: SttWord[];
}

/**
 * The default engine. Each {@link SttTransport.open} mints a fresh token via
 * `connectUrl()` and opens one socket; reconnect = open again.
 */
export function scribeTransport(options: ScribeTransportOptions): SttTransport {
  return {
    name: "scribe",
    capabilities: SCRIBE_CAPABILITIES,
    async open(callbacks) {
      // The credential act: a fresh single-use token, spent on this connect.
      const url = new URL(await options.connectUrl());
      // The engine's own requirements are asserted onto the URL — the
      // credential side owns custody, this side owns the wire contract.
      if (options.modelId !== undefined) {
        url.searchParams.set("model_id", options.modelId);
      }
      url.searchParams.set("audio_format", `pcm_${SCRIBE_SAMPLE_RATE}`);
      url.searchParams.set("include_timestamps", "true");
      const noVerbatim = options.noVerbatim ?? true;
      if (noVerbatim) {
        url.searchParams.set("no_verbatim", "true");
      }
      if (options.language !== undefined && options.language !== "") {
        url.searchParams.set("language_code", options.language);
      }
      for (const term of options.keyterms ?? []) {
        url.searchParams.append("keyterms", term);
      }
      const modelId = url.searchParams.get("model_id") ?? DEFAULT_SCRIBE_MODEL;
      return openScribeConnection(
        {
          url: url.toString(),
          modelId,
          noVerbatim,
          socketFactory: options.socketFactory ?? browserSocketFactory,
          now: options.now ?? Date.now,
        },
        callbacks,
      );
    },
  };
}

function openScribeConnection(
  config: {
    url: string;
    modelId: string;
    noVerbatim: boolean;
    socketFactory: SttSocketFactory;
    now: () => number;
  },
  callbacks: SttCallbacks,
): SttConnection {
  const { now } = config;
  /** What we asked for — diffed against the `session_started` echo on arrival. */
  const requestedConfig: Record<string, unknown> = {
    model_id: config.modelId,
    include_timestamps: true,
    ...(config.noVerbatim ? { no_verbatim: true } : {}),
  };

  // onSent arms the idle keepalive from every REAL outbound frame (never a
  // pre-ready enqueue — the ready-gate trap recorded in support.ts).
  const gate = createReadyGate((text) => socket.send(text), { onSent: () => armKeepalive() });

  // Committed segments awaiting their terminal event, in commit (FIFO) order —
  // the whole of segment↔result correlation on a wire with no item ids.
  const committed: CommittedSegment[] = [];
  // The segment whose audio is streaming right now — where a partial binds.
  let streamingSegment: number | undefined;
  // Total audio streamed since session start (never reset) — the axis Scribe's
  // word timestamps live on. And the uncommitted subset, which the commit
  // floor gates on; only a real commit (ours or the vendor's) resets it.
  let cumulativeBytes = 0;
  let uncommittedBytes = 0;
  // Each segment's audio base, pinned on its first append.
  const segmentBaseMs = new Map<number, number>();
  // Utterances Scribe closed on its own, per segment, awaiting that segment's final.
  const pending = new Map<number, PendingUtterances>();
  const drainCtl = createDrainController(() => committed.map((c) => c.segment));

  const EMPTY_AUDIO = new Uint8Array(0);
  const audioChunk = (bytes: Uint8Array, commit: boolean): object => ({
    message_type: "input_audio_chunk",
    audio_base_64: bytes.length > 0 ? toBase64(bytes) : "",
    commit,
    sample_rate: SCRIBE_SAMPLE_RATE,
  });

  // ── idle keepalive ─────────────────────────────────────────────────────────
  let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
  const clearKeepalive = (): void => {
    if (keepaliveTimer !== undefined) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = undefined;
    }
  };
  const armKeepalive = (): void => {
    clearKeepalive();
    if (gate.isDead()) {
      return;
    }
    keepaliveTimer = setTimeout(() => {
      if (gate.isDead()) {
        return;
      }
      socket.send(JSON.stringify(audioChunk(EMPTY_AUDIO, false)));
      armKeepalive();
    }, SCRIBE_KEEPALIVE_MS);
    // Never let the heartbeat alone hold a runner open (no-op in browsers).
    (keepaliveTimer as { unref?: () => void }).unref?.();
  };

  const sendFrame = (message: object): void => gate.send(JSON.stringify(message));

  /** The text Scribe already closed inside `segment`, joined for the preview. */
  const pendingText = (segment: number): string =>
    (pending.get(segment)?.texts ?? []).join(" ").trim();

  /**
   * A terminal frame: either the answer to OUR commit (FIFO head) or a
   * vendor self-commit (FIFO empty, audio still streaming) — see the module
   * header. A frame matching neither is an orphan-result diagnostic.
   */
  const completeHead = (messageType: string, message: { text?: string; words?: unknown }): void => {
    const head = committed.shift();
    const text = message.text ?? "";

    if (head === undefined) {
      if (streamingSegment === undefined) {
        callbacks.onDiagnostic?.({ kind: "orphan-result", messageType, chars: text.length });
        return;
      }
      const segment = streamingSegment;
      const baseMs = segmentBaseMs.get(segment) ?? 0;
      const words = convertScribeWords(message.words, baseMs);
      const slot = pending.get(segment) ?? { texts: [], words: [] };
      if (text !== "") {
        slot.texts.push(text);
      }
      slot.words.push(...words);
      pending.set(segment, slot);
      // Scribe just consumed its own buffer, so OUR uncommitted meter follows
      // it to zero — otherwise a commit shortly after a self-commit would be
      // sent for audio the server no longer holds (under its hard minimum:
      // commit_throttled, socket dead). Erring low is safe.
      uncommittedBytes = 0;
      callbacks.onDiagnostic?.({
        kind: "vendor-commit",
        segment,
        chars: text.length,
        words: words.length,
      });
      // Scribe's next partial restarts from empty; keep the caller's view cumulative.
      callbacks.onDelta(segment, pendingText(segment));
      return;
    }

    const slot = pending.get(head.segment);
    pending.delete(head.segment);
    const words = [...(slot?.words ?? []), ...convertScribeWords(message.words, head.audioBaseMs)];
    const full = [...(slot?.texts ?? []), ...(text !== "" ? [text] : [])].join(" ").trim();
    callbacks.onFinal(head.segment, {
      text: full,
      latencyMs: Math.max(0, now() - head.committedAt),
      model: config.modelId,
      ...(words.length > 0 ? { words } : {}),
    });
    drainCtl.settleIfIdle();
  };

  const handleError = (text: string): void => {
    // An error resolves the FIFO head loudly — it must leave the queue so a
    // later real completion can't double-finalize it.
    const head = committed.shift();
    if (head === undefined) {
      callbacks.onError(text);
      return;
    }
    callbacks.onError(text, head.segment);
    drainCtl.settleIfIdle();
  };

  const handleMessage = (raw: string): void => {
    let message: {
      message_type?: string;
      text?: string;
      words?: unknown;
      error?: string;
      config?: unknown;
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return; // a malformed upstream frame — ignore rather than crash
    }
    const type = message.message_type;
    if (type === undefined) {
      return;
    }
    switch (type) {
      case "session_started": {
        const echo =
          message.config && typeof message.config === "object"
            ? (message.config as Record<string, unknown>)
            : undefined;
        if (echo) {
          callbacks.onDiagnostic?.({ kind: "config-echo", config: echo });
          for (const m of checkScribeConfigEcho(requestedConfig, echo)) {
            callbacks.onDiagnostic?.({ kind: "config-mismatch", ...m });
          }
        }
        gate.markReady();
        armKeepalive(); // the arm→talk idle gap must not drop the socket
        return;
      }
      case "partial_transcript": {
        // Cumulative text for the current UNCOMMITTED UTTERANCE — not the
        // segment: Scribe restarts it from empty after each utterance it
        // closes itself, so prefix what it already closed.
        if (streamingSegment === undefined) {
          return;
        }
        const prefix = pendingText(streamingSegment);
        const text = message.text ?? "";
        callbacks.onDelta(streamingSegment, prefix ? `${prefix} ${text}`.trim() : text);
        return;
      }
      case "committed_transcript": {
        // `include_timestamps` is always on, so the timestamped twin carries
        // the same text plus words — this plain view would double-count.
        return;
      }
      case "committed_transcript_with_timestamps": {
        completeHead(type, message);
        return;
      }
      default: {
        if (isScribeErrorType(type)) {
          handleError(message.error ?? "realtime session error");
          return;
        }
        // Never a bare return: an unreported drop is how the self-commit
        // destroyed transcript unseen for months.
        callbacks.onDiagnostic?.({ kind: "unhandled", messageType: type, raw: raw.slice(0, 500) });
        return;
      }
    }
  };

  const fail = (message: string): void => {
    if (gate.isDead()) {
      return;
    }
    gate.markDead();
    clearKeepalive();
    const stuck = committed.splice(0);
    pending.clear();
    reportSessionFailure(
      callbacks.onError,
      message,
      stuck.map((entry) => entry.segment),
    );
    drainCtl.settleIfIdle();
  };

  const socket = config.socketFactory(config.url, undefined, {
    // No setup frame: the URL is the config; readiness is `session_started`.
    onOpen: () => {},
    onMessage: handleMessage,
    onError: (message) => fail(message),
    onClose: (code, reason) => {
      if (!gate.isDead()) {
        fail(`realtime session closed${closeSuffix(code, reason)}`);
      }
    },
  });

  return {
    appendAudio(segment, bytes) {
      if (gate.isDead()) {
        return;
      }
      // First append for this segment: pin its audio base BEFORE counting
      // these bytes, so its word timings can be rebased later.
      if (!segmentBaseMs.has(segment)) {
        segmentBaseMs.set(segment, cumulativeBytes / BYTES_PER_MS);
      }
      cumulativeBytes += bytes.length;
      uncommittedBytes += bytes.length;
      streamingSegment = segment;
      sendFrame(audioChunk(bytes, false));
    },
    commit(segment) {
      if (gate.isDead()) {
        callbacks.onError("realtime session unavailable", segment);
        return;
      }
      if (streamingSegment === segment) {
        streamingSegment = undefined;
      }
      const baseMs = segmentBaseMs.get(segment) ?? cumulativeBytes / BYTES_PER_MS;
      segmentBaseMs.delete(segment);
      // Under the floor: send NOTHING (the wire commit would be fatal) —
      // resolve the segment locally so the caller's preview settles. The
      // final is empty only if Scribe closed nothing inside this segment.
      if (uncommittedBytes / BYTES_PER_MS < SCRIBE_COMMIT_FLOOR_MS) {
        const slot = pending.get(segment);
        pending.delete(segment);
        const words = slot?.words ?? [];
        callbacks.onFinal(segment, {
          text: (slot?.texts ?? []).join(" ").trim(),
          latencyMs: 0,
          model: config.modelId,
          ...(words.length > 0 ? { words } : {}),
        });
        return;
      }
      committed.push({ segment, committedAt: now(), audioBaseMs: baseMs });
      uncommittedBytes = 0; // a successful commit resets the upstream buffer
      sendFrame(audioChunk(EMPTY_AUDIO, true));
    },
    discard(segment) {
      // No wire message — Scribe has no buffer-clear, and committing the
      // scrap is fatal. Drop the local binding; the ≤0.3 s stray stays in the
      // vendor buffer and counts toward the next utterance's commit floor.
      if (streamingSegment === segment) {
        streamingSegment = undefined;
      }
      segmentBaseMs.delete(segment);
      pending.delete(segment);
    },
    drain(timeoutMs) {
      return drainCtl.drain(timeoutMs);
    },
    close() {
      gate.markDead();
      clearKeepalive();
      try {
        socket.close();
      } catch {
        // best-effort — the socket may already be closing
      }
      drainCtl.releaseAll();
    },
  };
}
