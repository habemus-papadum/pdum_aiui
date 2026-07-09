/**
 * The ElevenLabs **Scribe v2 realtime** transcription engine, behind the same
 * {@link ./realtime}.RealtimeSession seam as OpenAI's `openRealtimeSession` —
 * so intent-v1 drives either vendor through one interface (appendAudio / commit
 * / discard / drain / close, results back through {@link RealtimeCallbacks}).
 *
 * Where OpenAI's realtime path is a stateful `session.update` handshake + an
 * `item_id`-keyed event stream, Scribe is deliberately leaner: **all config
 * rides the connect URL** (no in-band setup frame), and the wire carries **no
 * item ids at all** — committed utterances complete strictly in FIFO order. The
 * two facts drive most of this module's shape.
 *
 * ### Wire surface (Scribe v2 realtime; live-verified — `.aiui-cache/scribe-findings.md`)
 *
 *  - **Endpoint:** `wss://api.elevenlabs.io/v1/speech-to-text/realtime`, with the
 *    whole session config in the query string —
 *    `model_id`, `audio_format=pcm_24000`, `include_timestamps=true`,
 *    `no_verbatim=true`, plus optional `language_code` and a *repeatable*
 *    `keyterms` (domain-bias terms).
 *    Unknown query params are accepted *silently* — the only reliable proof a
 *    param took effect is the `session_started` config echo (so verify there,
 *    not by the absence of an error). We now DO verify it: see
 *    {@link checkConfigEcho}, reported through `onDiagnostic`. In particular
 *    `keyterms` **must** be repeated *plain* params (`keyterms=a&keyterms=b`);
 *    the bracket form `keyterms[]=` is silently dropped. And this URL once
 *    carried `commit_strategy=manual` — **there is no such parameter**; it never
 *    appeared in the echo, and the "PTT owns the boundary" guarantee it was
 *    supposed to buy was never in force (see the self-commit section below).
 *  - **Auth:** an `xi-api-key` request header (OpenAI is a bearer, Gemini a
 *    query param — the only per-vendor difference in the socket factory).
 *  - **Ready signal:** `session_started`. Audio queued before it is buffered and
 *    flushed once ready, exactly like `openRealtimeSession` queues until
 *    `session.updated`. There is NO config frame to send on open (the URL is the
 *    config), so the open handler is a no-op.
 *  - **Client → server:** every frame is one `input_audio_chunk`
 *    `{ audio_base_64, commit, sample_rate: 24000 }`. Audio frames set
 *    `commit:false`; a **commit is the same message with `commit:true`** and may
 *    carry empty audio. (No separate append/commit message types.)
 *  - **Server → client:**
 *    - `partial_transcript { text }` — the **cumulative** partial for the
 *      current *uncommitted* utterance (not an incremental delta — Scribe
 *      re-sends the whole running text), echoed straight to `onDelta` for the
 *      segment whose audio is streaming right now. Measured cadence: a fixed
 *      **~1 s server heartbeat** (~2.2 s to the first partial), content trailing
 *      the live audio edge by ~200–400 ms — treat partials as disposable preview,
 *      the committed transcript as truth.
 *    - `committed_transcript { text }` and
 *      `committed_transcript_with_timestamps { text, words[] }` — two views of
 *      the *same* completion (~180–210 ms and ~280–335 ms after the commit,
 *      respectively). With `include_timestamps` on (always, here) the timestamped
 *      one is authoritative and the plain one is ignored, so each committed
 *      segment fires `onFinal` exactly once. `words[]` entries are
 *      `{ text, start, end, type, speaker_id?, logprob? }` with `start`/`end` in
 *      **seconds on the session's CUMULATIVE audio timeline — they do NOT reset
 *      per segment** (see the timestamp-rebasing note below); we convert to
 *      integer segment-relative `startMs`/`endMs`, drop `type:"spacing"` filler
 *      tokens, and carry `logprob` through.
 *    - error message types (`error`, `auth_error`, `commit_throttled`, … — see
 *      {@link ELEVENLABS_ERROR_TYPES}) carry an `error` text; each is attributed
 *      to the **oldest in-flight committed segment** (FIFO head) if one exists,
 *      else surfaced session-wide.
 *
 * ### Scribe COMMITS UTTERANCES ITSELF — a segment is many utterances
 *
 * The single most important fact about this wire, and the one that cost us a
 * user's two-minute prompt (live-verified; `archive/scribe-realtime-spike.mjs`):
 *
 * **Scribe closes an utterance on its own, unprompted, and there is no way to
 * stop it.** Around 40 s of a continuous utterance it emits `committed_transcript`
 * + `committed_transcript_with_timestamps` for everything so far — with no commit
 * from us — and then **resets `partial_transcript` to empty** and starts a fresh
 * utterance. This is not the silence VAD (`vad_commit_strategy` echoes `false`,
 * and it fires well away from any pause); it is a cap on utterance length.
 *
 * So a push-to-talk **segment** (our unit) may contain SEVERAL Scribe
 * **utterances** (its unit). The session therefore accumulates: every terminal
 * frame arriving while a segment is still streaming is appended to that
 * segment's `pending` text + words, and the segment's `onFinal` concatenates all
 * of them with the answer to our own commit. `onDelta` prefixes the accumulated
 * text onto each partial, so the caller's cumulative-text contract survives the
 * vendor's reset.
 *
 * Before this, `completeHead` dropped any completion arriving with an empty FIFO
 * as a "stray" — so every self-committed utterance was destroyed, the preview
 * appeared to delete the user's words, and a long segment whose tail was silence
 * finalized EMPTY. Nothing on our side was diffing anything; we were discarding
 * the transcript. Hence `onDiagnostic`: no drop in this module is silent now.
 *
 * ### Segment correlation without item ids
 *
 * OpenAI hands every utterance an `item_id` we bind segments to; Scribe hands us
 * nothing, so correlation is purely positional: our commits enter a FIFO queue
 * and the completion that finds a head resolves it, while a completion that finds
 * none belongs to the segment currently streaming (above). `partial_transcript`
 * has no id either — it always describes the *uncommitted* utterance, so it binds
 * to the single segment currently streaming audio.
 *
 * ### `commit_throttled` is FATAL — the 500 ms commit floor
 *
 * Live finding (Q7): committing with **< 0.3 s of uncommitted audio** doesn't just
 * fail — the server returns `commit_throttled` and **closes the socket**, with no
 * recovery. The uncommitted buffer resets to 0 only on a *successful* commit. So
 * this session tracks uncommitted-audio milliseconds locally (bytes since the last
 * successful commit ÷ {@link BYTES_PER_MS}) and gates every commit behind
 * {@link ELEVENLABS_COMMIT_FLOOR_MS} (500 ms — a margin over the 300 ms hard
 * minimum, because a violation costs the whole session). A `commit(segment)` under
 * the floor sends **nothing** on the wire: it resolves the segment as an empty
 * final (so the caller's preview still settles) and leaves the stray audio in the
 * buffer to prepend to the next utterance — the same quiet resolution as
 * `openRealtimeSession`'s discard path, but without a wire commit.
 *
 * ### `discard` sends nothing — the asymmetry vs OpenAI
 *
 * OpenAI drops a sub-100 ms tap with `input_audio_buffer.clear`, wiping the
 * buffer. **Scribe has no buffer-clear message, and committing the scrap is fatal
 * (above).** So `discard(segment)` here synthesizes **nothing on the wire**: it
 * drops the local binding (a stale partial for the segment stops leaking to
 * `onDelta`) and leaves the stray audio in the upstream buffer, where it prepends
 * to — and counts toward the commit floor of — the next utterance. Accepted
 * tradeoff: the leftover is ≤ 0.3 s of near-silence, and the only true buffer
 * reset is a socket teardown, which isn't worth spending on a sub-tap.
 *
 * ### Idle keepalive (the ~15 s server timeout)
 *
 * The caller opens the session eagerly at thread-open, then it sits idle through
 * the arm→talk gap. Scribe closes an idle socket **~15 s after `session_started`**
 * (`code=1000`, empty reason), which without a keepalive surfaces as a session-wide
 * "realtime session closed (1000)" and **no transcription at all** — the exact bug
 * this guards against. While ready, the session sends an empty
 * ({@link ELEVENLABS_KEEPALIVE_MS}-cadence) `input_audio_chunk` during silence to
 * hold the socket open; a real frame resets the timer. See
 * {@link ELEVENLABS_KEEPALIVE_MS}.
 *
 * ### Timestamp rebasing (cumulative → segment-relative)
 *
 * Our {@link TranscriptWord} contract is "ms from the segment's first sample", but
 * Scribe's `word.start/end` are on the whole session's cumulative audio timeline
 * (sentence 2 measured starting at ~10.16 s, not 0). So each segment records its
 * **audio base** — the cumulative audio ms streamed *before* its first
 * `appendAudio` — and {@link convertWords} subtracts that base (clamped at ≥ 0) to
 * make the timings segment-local again.
 *
 * The upstream socket is injectable ({@link RealtimeSocketFactory}) so the unit
 * tests drive a scripted fake session with no network and no key — the same seam
 * pattern as `realtime.ts` and `gemini-live.ts`.
 */

import WebSocket from "ws";
import {
  captureUnexpectedResponse,
  closeSuffix,
  type RealtimeCallbacks,
  type RealtimeSession,
  type RealtimeSocketFactory,
  type RealtimeSocketHandlers,
  type TranscriptWord,
} from "./realtime";

/** The Scribe v2 realtime transcription endpoint (session config rides the query string). */
export const ELEVENLABS_REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

/** The default realtime transcription model. */
export const DEFAULT_ELEVENLABS_MODEL = "scribe_v2_realtime";

/** The client capture rate; matches the URL's `audio_format=pcm_24000` and each chunk's `sample_rate`. */
const ELEVENLABS_SAMPLE_RATE = 24000;

/** PCM16 mono at 24 kHz: 24000 samples/s × 2 bytes ÷ 1000 = 48 bytes per ms — the meter's unit. */
const BYTES_PER_MS = (ELEVENLABS_SAMPLE_RATE * 2) / 1000;

/**
 * The local floor, in ms of uncommitted audio, below which we REFUSE to send a
 * commit. Scribe's hard minimum is 300 ms — committing under it returns
 * `commit_throttled` and the server closes the socket (fatal, no recovery). We
 * hold a 200 ms margin because the violation costs the whole session, not just the
 * commit. A commit under this floor resolves as an empty final instead of a wire
 * commit (see {@link openElevenLabsRealtimeSession}).
 */
export const ELEVENLABS_COMMIT_FLOOR_MS = 500;

/**
 * Idle keepalive cadence. Live finding: with no audio, the server closes the
 * socket **~15 s after `session_started`** — `code=1000`, empty reason (measured
 * 15028 ms). The caller opens the session eagerly at thread-open (so the
 * handshake overlaps the arm→talk gap), so any arm→talk or between-utterance
 * pause longer than that would drop the socket *before* the user speaks — no
 * partials, and a session-wide "realtime session closed (1000)". Every
 * KEEPALIVE_MS of outbound silence we send one empty (`audio_base_64:""`,
 * `commit:false`) chunk, which resets the server's idle timer. 10 s leaves a 5 s
 * margin, and an EMPTY chunk carries **zero** bytes: it never enters the buffer,
 * never shifts the cumulative word-timestamp timeline, never touches the commit
 * floor (all live-verified). OpenAI's realtime path needs none of this.
 */
export const ELEVENLABS_KEEPALIVE_MS = 10_000;

/**
 * The `message_type`s Scribe uses to report a fault. Some end in `error`
 * (`auth_error`, `input_error`, `transcriber_error`); most are named conditions
 * (`quota_exceeded`, `commit_throttled`, …) — all carry an `error` text and are
 * routed identically. `commit_throttled` is here defensively: the local floor
 * ({@link ELEVENLABS_COMMIT_FLOOR_MS}) should keep us from ever provoking it.
 * Exported so the set is testable and any future addition has one place to land;
 * {@link isErrorType} also treats an unknown `*error` type as a fault, so a new one
 * degrades to an error rather than silence.
 */
export const ELEVENLABS_ERROR_TYPES: ReadonlySet<string> = new Set([
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

/** True for a Scribe error `message_type` — the known set, plus any unknown `*error`. */
export function isErrorType(type: string): boolean {
  return ELEVENLABS_ERROR_TYPES.has(type) || type.endsWith("error");
}

export interface ElevenLabsRealtimeSessionOptions {
  apiKey: string;
  /** Resolves the model id at open time. Default: {@link DEFAULT_ELEVENLABS_MODEL}. */
  modelId?: () => string;
  /** Resolves the language code (`language_code`); undefined → let Scribe auto-detect. */
  language?: () => string | undefined;
  /** Resolves domain keyterms to bias the model (repeatable `keyterms`); undefined/empty → none. */
  keyterms?: () => readonly string[] | undefined;
  /** Collapse disfluencies/false-starts (`no_verbatim`). Default `true`. */
  noVerbatim?: boolean;
  /** Override the endpoint (tests). */
  url?: string;
  /** Injected upstream socket (tests); defaults to the real `ws` factory. */
  socketFactory?: RealtimeSocketFactory;
  /** Injected clock (tests); defaults to `Date.now`. */
  now?: () => number;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/**
 * The real upstream factory: a `ws` WebSocket to ElevenLabs, authed with the
 * `xi-api-key` header (mirrors {@link ./realtime}.openaiRealtimeSocketFactory,
 * differing only in the header name). Server-side only; the channel always runs
 * under Node, where `ws` is a dependency.
 */
export const elevenLabsSocketFactory: RealtimeSocketFactory = (url, apiKey, handlers) => {
  const ws = new WebSocket(url, { headers: { "xi-api-key": apiKey } });
  ws.on("open", () => handlers.onOpen());
  ws.on("message", (data: unknown) => handlers.onMessage(String(data)));
  ws.on("error", (err: Error) => handlers.onError(err.message));
  ws.on("close", (code: number, reason: Buffer) => handlers.onClose(code, reason.toString()));
  captureUnexpectedResponse(ws, handlers);
  return {
    send: (text) => ws.send(text),
    close: () => ws.close(),
  };
};

/**
 * Build the connect URL: the base endpoint plus the full session config as query
 * params (Scribe has no in-band setup frame). `keyterms` is repeatable, so each
 * term is `append`ed as its own **plain** param (`keyterms=a&keyterms=b`) — the
 * bracket form `keyterms[]=` is silently ignored by the server. `no_verbatim` is
 * included only when enabled — omitting it leaves the vendor default (verbatim),
 * the way OpenAI's `delay` is omitted when unset.
 */
export function buildElevenLabsUrl(
  base: string,
  config: {
    modelId: string;
    includeTimestamps: boolean;
    noVerbatim: boolean;
    language?: string;
    keyterms?: readonly string[];
  },
): string {
  const url = new URL(base);
  url.searchParams.set("model_id", config.modelId);
  url.searchParams.set("audio_format", `pcm_${ELEVENLABS_SAMPLE_RATE}`);
  url.searchParams.set("include_timestamps", String(config.includeTimestamps));
  if (config.noVerbatim) {
    url.searchParams.set("no_verbatim", "true");
  }
  // NOTE: this URL once carried `commit_strategy=manual`. No such parameter
  // exists — it is absent from the `session_started` config echo, and Scribe
  // accepts unknown query params silently, so it looked like it worked for
  // months while Scribe went on closing utterances by itself. Do not add a param
  // here without confirming it comes back in the echo (see checkConfigEcho).
  if (config.language !== undefined && config.language !== "") {
    url.searchParams.set("language_code", config.language);
  }
  for (const term of config.keyterms ?? []) {
    url.searchParams.append("keyterms", term);
  }
  return url.toString();
}

/**
 * Convert Scribe's `committed_transcript_with_timestamps` `words[]` into our
 * {@link TranscriptWord}[]: seconds → integer milliseconds, **rebased** by
 * `baseMs` (the cumulative audio ms streamed before this segment began, since
 * Scribe's timings are session-cumulative, not per-segment) and clamped at ≥ 0,
 * `type:"spacing"` filler dropped (it carries no lexical content), `logprob`
 * carried through. Tolerant — a malformed entry contributes nothing rather than
 * throwing.
 */
export function convertWords(raw: unknown, baseMs = 0): TranscriptWord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rebase = (seconds: number): number => Math.max(0, Math.round(seconds * 1000 - baseMs));
  const out: TranscriptWord[] = [];
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

/** One committed segment awaiting its terminal event, in FIFO (commit) order. */
interface CommittedSegment {
  segment: number;
  committedAt: number;
  /** Cumulative audio ms streamed before this segment began — the timestamp rebase base. */
  audioBaseMs: number;
}

/** Utterances Scribe closed on its own inside a segment, awaiting that segment's final. */
interface PendingUtterances {
  texts: string[];
  words: TranscriptWord[];
}

/** The params we can prove took effect by reading them back out of the echo. */
const ECHOED_PARAMS = ["model_id", "include_timestamps", "no_verbatim"] as const;

/**
 * Diff what we asked for against Scribe's `session_started` config echo. Unknown
 * query params are accepted *silently* by this vendor, so the echo is the only
 * evidence a param exists at all — a missing or contradicting key means the
 * behavior we think we configured is not in force. Reports, never throws:
 * a mismatch is information, not a reason to kill a working session.
 */
export function checkConfigEcho(
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

/**
 * Open a Scribe v2 realtime transcription session. Eagerly connects (the caller
 * opens it at thread-open so the handshake overlaps the arm→talk gap); audio
 * queued before `session_started` is flushed once the session is ready.
 */
export function openElevenLabsRealtimeSession(
  options: ElevenLabsRealtimeSessionOptions,
  callbacks: RealtimeCallbacks,
): RealtimeSession {
  const now = options.now ?? Date.now;
  const factory = options.socketFactory ?? elevenLabsSocketFactory;
  const noVerbatim = options.noVerbatim ?? true;
  // Config is all query string, so it is resolved once, here, to build the URL —
  // there is no later handshake to carry it (contrast OpenAI's `session.update`).
  const modelId = options.modelId?.() ?? DEFAULT_ELEVENLABS_MODEL;
  const url = buildElevenLabsUrl(options.url ?? ELEVENLABS_REALTIME_URL, {
    modelId,
    includeTimestamps: true,
    noVerbatim,
    ...(options.language?.() !== undefined ? { language: options.language() } : {}),
    ...(options.keyterms?.() !== undefined ? { keyterms: options.keyterms() } : {}),
  });
  /** What we asked for — diffed against the `session_started` echo on arrival. */
  const requestedConfig: Record<string, unknown> = {
    model_id: modelId,
    include_timestamps: true,
    ...(noVerbatim ? { no_verbatim: true } : {}),
  };

  let ready = false;
  let dead = false;
  const outbox: string[] = [];

  // Committed segments awaiting their terminal event, in commit (FIFO) order —
  // the whole of segment↔result correlation on a wire with no item ids.
  const committed: CommittedSegment[] = [];
  // The segment whose audio is streaming right now (appending, not yet
  // committed) — where a `partial_transcript` binds. Cleared on its commit or
  // discard so a stray late partial can't leak to it.
  let streamingSegment: number | undefined;
  // Total audio streamed since session start (never reset) — the axis Scribe's
  // word timestamps live on. And the uncommitted subset (bytes since the last
  // SUCCESSFUL commit), which the commit floor gates on and only a real commit
  // resets. A discard leaves both untouched: the scrap stays in the buffer.
  let cumulativeBytes = 0;
  let uncommittedBytes = 0;
  // Each segment's audio base (cumulative ms before its first append), recorded
  // once on that first append and read at commit time to rebase its word timings.
  const segmentBaseMs = new Map<number, number>();
  // Utterances Scribe closed on its own, per segment, waiting to be concatenated
  // into that segment's final. Non-empty whenever a long segment is in progress.
  const pending = new Map<number, PendingUtterances>();
  const drainWaiters: Array<() => void> = [];

  const settleDrainIfIdle = (): void => {
    if (committed.length === 0) {
      for (const resolve of drainWaiters.splice(0)) {
        resolve();
      }
    }
  };

  /** The empty payload for a commit / discard / keepalive chunk (no audio bytes). */
  const EMPTY_AUDIO = new Uint8Array(0);

  const audioChunk = (bytes: Uint8Array, commit: boolean): object => ({
    message_type: "input_audio_chunk",
    audio_base_64: bytes.length > 0 ? toBase64(bytes) : "",
    commit,
    sample_rate: ELEVENLABS_SAMPLE_RATE,
  });

  // ── idle keepalive ──────────────────────────────────────────────────────────
  // Scribe closes an idle socket ~15 s after `session_started`; an empty chunk
  // resets that timer without touching the buffer or the word-timestamp timeline
  // (see {@link ELEVENLABS_KEEPALIVE_MS}).
  let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
  const clearKeepalive = (): void => {
    if (keepaliveTimer !== undefined) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = undefined;
    }
  };
  // (Re)arm from the most recent outbound frame; each real send pushes it out, so
  // a keepalive fires only after ELEVENLABS_KEEPALIVE_MS of true silence. Only
  // while ready + alive.
  const armKeepalive = (): void => {
    clearKeepalive();
    if (!ready || dead) {
      return;
    }
    keepaliveTimer = setTimeout(() => {
      if (!ready || dead) {
        return;
      }
      socket.send(JSON.stringify(audioChunk(EMPTY_AUDIO, false)));
      armKeepalive();
    }, ELEVENLABS_KEEPALIVE_MS);
    // Never let the heartbeat alone hold the process (or a test runner) open.
    (keepaliveTimer as { unref?: () => void }).unref?.();
  };

  // Frames wait for `session_started`; there is no config handshake to bypass the
  // queue with (the URL is the config), so everything the caller sends is queued
  // until ready. A dead session drops silently.
  const sendFrame = (message: object): void => {
    const text = JSON.stringify(message);
    if (ready && !dead) {
      socket.send(text);
      armKeepalive(); // real activity resets the idle timer
    } else if (!dead) {
      outbox.push(text);
    }
  };

  /** The text Scribe already closed inside `segment`, joined for the preview. */
  const pendingText = (segment: number): string =>
    (pending.get(segment)?.texts ?? []).join(" ").trim();

  /**
   * A terminal frame. Two cases, and telling them apart is the whole ballgame:
   *
   *  - **Our commit's answer** (the FIFO has a head): the segment is done. Its
   *    final text is everything Scribe closed inside it, *plus* this last piece.
   *  - **Scribe's own commit** (FIFO empty, audio still streaming): Scribe caps
   *    an utterance on its own — around 40 s, live-verified, and NOT switchable
   *    off (`vad_commit_strategy` is already false). It then resets its partial
   *    to empty. This used to `return` as "stray", which silently destroyed the
   *    utterance and made the preview look like it was deleting the user's
   *    words. Now it accumulates against the streaming segment and re-emits the
   *    accumulated text as a delta, so `onDelta`'s cumulative contract holds
   *    across the reset.
   *
   * Residual race (recorded, not silently swallowed): the wire is ordered, so a
   * self-commit is always *emitted* before the answer to a later commit of ours.
   * But if one is still in flight when we push to the FIFO, it would be taken
   * for our answer and the true tail would then arrive with the FIFO empty and
   * no streaming segment — an `orphan-result` diagnostic, which is exactly the
   * signal that this needs an id-carrying protocol rather than position.
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
      const words = convertWords(message.words, baseMs);
      const slot = pending.get(segment) ?? { texts: [], words: [] };
      if (text !== "") {
        slot.texts.push(text);
      }
      slot.words.push(...words);
      pending.set(segment, slot);
      // Scribe just consumed its own buffer, so OUR uncommitted meter must follow
      // it back to zero. Otherwise the meter keeps climbing, and a commit issued
      // shortly after a self-commit would be sent for audio the server no longer
      // holds — under its 300 ms hard minimum, which returns `commit_throttled`
      // and kills the socket. Erring low is safe: a refused commit still resolves
      // the segment from `pending`.
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
    const words = [...(slot?.words ?? []), ...convertWords(message.words, head.audioBaseMs)];
    const full = [...(slot?.texts ?? []), ...(text !== "" ? [text] : [])].join(" ").trim();
    callbacks.onFinal(head.segment, {
      text: full,
      latencyMs: Math.max(0, now() - head.committedAt),
      model: modelId,
      ...(words.length > 0 ? { words } : {}),
    });
    settleDrainIfIdle();
  };

  const handleError = (text: string): void => {
    // An error resolves the FIFO head loudly (its completion, but a failed one) —
    // it must leave the queue so a later real completion can't double-finalize it.
    const head = committed.shift();
    if (head === undefined) {
      callbacks.onError(text); // nothing in flight — session-wide
      return;
    }
    callbacks.onError(text, head.segment);
    settleDrainIfIdle();
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
      return; // a malformed upstream frame — ignore rather than crash the thread
    }
    const type = message.message_type;
    if (type === undefined) {
      return;
    }
    switch (type) {
      case "session_started": {
        ready = true;
        // The config echo: the only proof our connect-URL params took effect.
        // Recorded verbatim, then diffed — a param this vendor does not know is
        // accepted silently, so silence is never evidence of success.
        const echo =
          message.config && typeof message.config === "object"
            ? (message.config as Record<string, unknown>)
            : undefined;
        if (echo) {
          callbacks.onDiagnostic?.({ kind: "config-echo", config: echo });
          for (const m of checkConfigEcho(requestedConfig, echo)) {
            callbacks.onDiagnostic?.({ kind: "config-mismatch", ...m });
          }
        }
        for (const queued of outbox.splice(0)) {
          socket.send(queued);
        }
        armKeepalive(); // start the heartbeat so the arm→talk idle gap can't drop us
        return;
      }
      case "partial_transcript": {
        // Cumulative text for the current *uncommitted utterance* — which is not
        // the same thing as the segment: Scribe restarts it from empty after each
        // utterance it closes itself. Prefix what it already closed so the
        // caller keeps seeing one growing transcript per segment.
        if (streamingSegment === undefined) {
          return;
        }
        const prefix = pendingText(streamingSegment);
        const text = message.text ?? "";
        callbacks.onDelta(streamingSegment, prefix ? `${prefix} ${text}`.trim() : text);
        return;
      }
      case "committed_transcript": {
        // `include_timestamps` is always on, so the timestamped twin carries the
        // same text plus words — this plain view would double-count. Ignored on
        // purpose (not a drop): the twin lands ~100 ms later and does the work.
        return;
      }
      case "committed_transcript_with_timestamps": {
        completeHead(type, message);
        return;
      }
      default: {
        if (isErrorType(type)) {
          handleError(message.error ?? "realtime session error");
          return;
        }
        // Never a bare `return` again. An unknown type is a message this vendor
        // added, or one we misread — either way it is reported, because that is
        // exactly how the self-commit went unseen.
        callbacks.onDiagnostic?.({ kind: "unhandled", messageType: type, raw: raw.slice(0, 500) });
        return;
      }
    }
  };

  /** A transport-level fault (socket error / close): finalize the queue loudly, then idle. */
  const fail = (message: string): void => {
    if (dead) {
      return;
    }
    dead = true;
    clearKeepalive();
    const stuck = committed.splice(0);
    pending.clear();
    for (const entry of stuck) {
      callbacks.onError(message, entry.segment);
    }
    if (stuck.length === 0) {
      callbacks.onError(message);
    }
    settleDrainIfIdle();
  };

  const socket = factory(url, options.apiKey, {
    // No setup frame: Scribe's config is entirely in the connect URL, so open is
    // a no-op and readiness is the server's `session_started`.
    onOpen: () => {},
    onMessage: handleMessage,
    onError: (message) => fail(message),
    onClose: (code, reason) => {
      // A clean close after a drain finds nothing queued (a no-op fail). A close
      // mid-flight finalizes the outstanding segments loudly — with the vendor's
      // close reason, which is where the actual error text lives (e.g. a
      // `commit_throttled` teardown rides `reason="commit_throttled"`).
      if (!dead) {
        fail(`realtime session closed${closeSuffix(code, reason)}`);
      }
    },
  } satisfies RealtimeSocketHandlers);

  return {
    appendAudio(segment, bytes) {
      if (dead) {
        return;
      }
      // First append for this segment: pin its audio base (cumulative ms so far)
      // BEFORE counting these bytes, so its word timings can be rebased later.
      if (!segmentBaseMs.has(segment)) {
        segmentBaseMs.set(segment, cumulativeBytes / BYTES_PER_MS);
      }
      cumulativeBytes += bytes.length;
      uncommittedBytes += bytes.length;
      // The segment ordinal isn't carried on the wire (Scribe's buffer is
      // implicit) — appending marks this segment as the streaming one, where a
      // `partial_transcript` binds.
      streamingSegment = segment;
      sendFrame(audioChunk(bytes, false));
    },
    commit(segment) {
      if (dead) {
        callbacks.onError("realtime session unavailable", segment);
        return;
      }
      if (streamingSegment === segment) {
        streamingSegment = undefined; // committed — no longer the partial's bind target
      }
      const baseMs = segmentBaseMs.get(segment) ?? cumulativeBytes / BYTES_PER_MS;
      segmentBaseMs.delete(segment);
      // Gate on the local floor: committing under it is FATAL on this wire
      // (`commit_throttled` closes the socket). Below the floor we send NOTHING —
      // resolve the segment as a final so the caller's preview settles, and
      // leave the audio in the buffer (uncommittedBytes untouched) to prepend to
      // the next utterance. The final is empty ONLY if Scribe closed nothing
      // inside this segment: a long segment ending in a sub-floor scrap of audio
      // still owns everything the vendor already committed within it.
      if (uncommittedBytes / BYTES_PER_MS < ELEVENLABS_COMMIT_FLOOR_MS) {
        const slot = pending.get(segment);
        pending.delete(segment);
        const words = slot?.words ?? [];
        callbacks.onFinal(segment, {
          text: (slot?.texts ?? []).join(" ").trim(),
          latencyMs: 0,
          model: modelId,
          ...(words.length > 0 ? { words } : {}),
        });
        return;
      }
      committed.push({ segment, committedAt: now(), audioBaseMs: baseMs });
      uncommittedBytes = 0; // a successful commit resets the upstream buffer to 0
      sendFrame(audioChunk(EMPTY_AUDIO, true));
    },
    discard(segment) {
      // No wire message: Scribe has no buffer-clear, and committing the scrap is
      // fatal (commit_throttled). So discard only drops the local binding — a
      // stale partial for the segment stops leaking — and leaves the stray audio
      // in the buffer (cumulative + uncommitted counters untouched), where it
      // prepends to, and counts toward the commit floor of, the next utterance.
      if (streamingSegment === segment) {
        streamingSegment = undefined;
      }
      segmentBaseMs.delete(segment);
      pending.delete(segment); // a discarded segment's vendor-committed text goes with it
    },
    drain(timeoutMs) {
      if (committed.length === 0) {
        return Promise.resolve([]);
      }
      return new Promise<number[]>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(committed.map((c) => c.segment));
        };
        const timer = setTimeout(finish, timeoutMs);
        drainWaiters.push(finish);
      });
    },
    close() {
      dead = true;
      clearKeepalive();
      try {
        socket.close();
      } catch {
        // best-effort — the socket may already be closing
      }
      // Release any drain still waiting so `fin` never hangs on a closed socket.
      for (const resolve of drainWaiters.splice(0)) {
        resolve();
      }
    },
  };
}
