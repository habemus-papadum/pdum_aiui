/**
 * The realtime transcription seam — server-side, the streaming sibling of
 * {@link ./transcribe}'s REST `openaiTranscriber`.
 *
 * Where the REST path is one blob in → one timed transcript out, this holds a
 * **per-thread WebSocket** to OpenAI's realtime transcription endpoint and
 * streams a segment's PCM *while you talk*: `input_audio_buffer.append` per
 * frame, `input_audio_buffer.commit` at talk-end, partial `…delta` events echoed
 * back as they arrive, a `…completed` event as the segment's final. REST stays
 * the default and the fallback; this is the L1 spike (streaming-turns.md §3).
 *
 * ### Verified GA surface (developers.openai.com, re-verified live 2026-07-05)
 *
 * The design doc sketched the **Beta** shape (`OpenAI-Beta: realtime=v1`,
 * `transcription_session.update`); that shape is now **disabled** — a live probe
 * returned `beta_api_shape_disabled` ("use /v1/realtime for the GA API"). The GA
 * shape this implements, confirmed against the running endpoint:
 *
 *  - **Endpoint:** `wss://api.openai.com/v1/realtime?intent=transcription`.
 *  - **Auth:** `Authorization: Bearer <key>` **only** — no `OpenAI-Beta` header.
 *  - **Configure:** one `session.update` with a nested transcription session:
 *    `{ type: "session.update", session: { type: "transcription", audio: {
 *      input: { format: { type: "audio/pcm", rate: 24000 },
 *               transcription: { model, delay? }, turn_detection: null } } } }`.
 *    `turn_detection: null` = manual commit (PTT is the boundary). `delay`
 *    (`minimal|low|medium|high|xhigh`) is a real knob but must be **omitted**
 *    when unset — an empty string 400s.
 *  - **Ready signal:** `session.updated` (start streaming after it).
 *  - **Client → server:** `input_audio_buffer.append { audio: <base64 PCM16> }`,
 *    `input_audio_buffer.commit`.
 *  - **Server → client:** `conversation.item.input_audio_transcription.delta
 *    { item_id, delta }` (partial — `delta` is *incremental*, so we accumulate),
 *    `…transcription.completed { item_id, transcript }` (final). `item_id`
 *    correlates events for one committed segment. Deltas start **while audio is
 *    still appending** — well before the commit (that's the entire point of the
 *    streaming tier: partials as you talk) — so an unseen `item_id` with no
 *    committed segment to claim it belongs to the segment streaming right now.
 *
 * The upstream socket is injectable ({@link RealtimeSocketFactory}) so the unit
 * tests drive a scripted fake session with no network and no key — the same seam
 * pattern as `transcribe.ts`'s injected `fetch`.
 */
import WebSocket from "ws";
import { type CallCost, priceCall, usageFromTranscription } from "./cost";

/** The verified GA endpoint for a transcription-intent realtime session. */
export const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

/** The default realtime transcription model (a natively-streaming whisper). */
export const DEFAULT_REALTIME_MODEL = "gpt-realtime-whisper";

/**
 * One transcribed word with its position in the SEGMENT'S OWN AUDIO —
 * milliseconds from the segment's first sample — plus the model's confidence
 * when the vendor reports one. Timings are segment-relative (not session
 * clock): a vendor that gives per-word timestamps (ElevenLabs Scribe) reports
 * them against the committed segment's audio, so they compose directly with the
 * segment's own boundaries.
 */
export interface TranscriptWord {
  text: string;
  startMs?: number;
  endMs?: number;
  logprob?: number;
}

/** One realtime transcript result (mirrors {@link ./transcribe}.TranscriptResult). */
export interface RealtimeResult {
  text: string;
  /** Wall-clock from the segment's commit (talk-end) to its `…completed`. */
  latencyMs: number;
  model: string;
  /**
   * The segment's cost, when the upstream `…completed` carried usage. May
   * arrive with `usd` absent — the realtime STT models can be newer than the
   * price catalog — in which case the usage is still accounted in the trace.
   */
  cost?: CallCost;
  /**
   * Per-word timings + confidence, when the vendor emits them (ElevenLabs
   * Scribe with `include_timestamps`). Absent on transports that only return a
   * flat transcript (the OpenAI realtime path). Segment-relative — see
   * {@link TranscriptWord}.
   */
  words?: TranscriptWord[];
}

/** What a realtime session reports back, keyed by our own segment ordinal. */
/**
 * Something the vendor did that the session did not act on, or acted on in a way
 * worth recording. Purely observational — a diagnostic never changes control
 * flow, and a caller may ignore them all. They exist because every silent
 * `default: return` in a vendor message switch is a place transcript can vanish
 * without a trace: Scribe self-committed utterances for months and the channel
 * dropped every one of them, unseen, because the drop was a bare `return`.
 *
 *  - `config-echo` — the vendor's own report of the session config it applied.
 *    The ONLY proof a connect-URL param took effect (unknown params are accepted
 *    silently), so it is recorded verbatim and diffed against what we asked for.
 *  - `config-mismatch` — a param we set that the echo does not confirm.
 *  - `vendor-commit` — the vendor closed an utterance we never asked it to close.
 *  - `orphan-result` — a terminal frame that matched no segment at all.
 *  - `unhandled` — a message type this session does not understand.
 */
export type RealtimeDiagnostic =
  | { kind: "config-echo"; config: Record<string, unknown> }
  | { kind: "config-mismatch"; param: string; requested: unknown; echoed: unknown }
  | { kind: "vendor-commit"; segment: number; chars: number; words: number }
  | { kind: "orphan-result"; messageType: string; chars: number }
  | { kind: "unhandled"; messageType: string; raw: string };

/**
 * Diff the `session.update` we sent against the `session.updated` the server
 * echoes back. Unlike Scribe, OpenAI *rejects* an unknown param with an `error`
 * — but it will happily accept one it knows and apply a different value, and
 * `turn_detection: null` (our entire manual-commit premise) is exactly the kind
 * of thing worth proving rather than assuming. Reports, never throws.
 *
 * `echo` is the `session` object of a `session.updated` frame.
 */
export function checkRealtimeConfigEcho(
  requested: { model: string; turnDetection: null },
  echo: unknown,
): Array<{ param: string; requested: unknown; echoed: unknown }> {
  const input = (echo as { audio?: { input?: Record<string, unknown> } } | undefined)?.audio?.input;
  if (input === undefined) {
    return [];
  }
  const out: Array<{ param: string; requested: unknown; echoed: unknown }> = [];
  // The one that matters: anything non-null here means the server owns the turn
  // boundary, not our push-to-talk, and it will commit utterances by itself.
  if (input.turn_detection != null) {
    out.push({
      param: "turn_detection",
      requested: requested.turnDetection,
      echoed: input.turn_detection,
    });
  }
  const model = (input.transcription as { model?: unknown } | undefined)?.model;
  if (model !== undefined && model !== requested.model) {
    out.push({ param: "transcription.model", requested: requested.model, echoed: model });
  }
  return out;
}

export interface RealtimeCallbacks {
  /**
   * A partial transcript for `segment` — cumulative text (not the raw delta).
   * Fires from the moment the model starts transcribing, i.e. while the
   * segment's audio is still streaming, before its commit.
   */
  onDelta(segment: number, cumulativeText: string): void;
  /** The final transcript for `segment`. */
  onFinal(segment: number, result: RealtimeResult): void;
  /**
   * A failure. `segment` names the committed segment it belongs to (so the
   * caller can finalize just that one loudly); undefined for a session-wide
   * fault before any commit.
   */
  onError(message: string, segment?: number): void;
  /** Optional protocol observability — see {@link RealtimeDiagnostic}. */
  onDiagnostic?(event: RealtimeDiagnostic): void;
}

/**
 * The minimal upstream socket the session drives — a subset of `ws`'s surface,
 * so a test can supply a scripted fake with no network. The factory wires the
 * handlers; the returned object is what the session sends on / closes.
 */
export interface RealtimeSocket {
  send(text: string): void;
  close(): void;
}

/** Handlers the session hands the factory to observe the upstream socket. */
export interface RealtimeSocketHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  /**
   * A transport fault. `data` optionally carries the structured upstream
   * payload (e.g. a rejected handshake's HTTP status + response body) so the
   * session can surface what the API actually said, not just a summary line.
   */
  onError(message: string, data?: unknown): void;
  /**
   * The socket closed. Vendors report *why* in the close frame — Gemini puts
   * the real error text ("API key not valid …") in `reason` — so the factory
   * forwards both when it has them; handlers that ignore them are unchanged.
   */
  onClose(code?: number, reason?: string): void;
}

/**
 * Render a close frame's code/reason as a parenthesized suffix for a
 * "session closed" fault message — `" (1007: API key not valid …)"` — or ""
 * when the factory had neither (a scripted test fake, an abrupt teardown).
 * The reason is where vendors state the actual error, so it leads the text
 * a human reads.
 */
/**
 * Fold OpenAI's TOKEN-level transcription logprobs into WORD-level
 * {@link TranscriptWord}s (no timestamps on this wire — words carry only
 * `logprob`). Tokens concatenate to the transcript; a word's confidence is
 * its WORST token (min logprob) — one unsure token is what makes a word
 * worth re-speaking, and averaging would hide it. Tolerant by design:
 * malformed/absent logprobs → undefined (the final simply carries no words),
 * and any drift between token concatenation and the final text ends the
 * fold early rather than mislabeling words.
 */
export function wordsFromTokenLogprobs(text: string, raw: unknown): TranscriptWord[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const tokens: Array<{ token: string; logprob: number }> = [];
  for (const entry of raw) {
    const t = (entry ?? {}) as { token?: unknown; logprob?: unknown };
    if (typeof t.token !== "string" || typeof t.logprob !== "number") {
      return undefined;
    }
    tokens.push({ token: t.token, logprob: t.logprob });
  }
  const words: TranscriptWord[] = [];
  let wordText = "";
  let worst = Number.POSITIVE_INFINITY;
  const flush = (): void => {
    const trimmed = wordText.trim();
    if (trimmed !== "") {
      words.push({ text: trimmed, logprob: worst });
    }
    wordText = "";
    worst = Number.POSITIVE_INFINITY;
  };
  for (const { token, logprob } of tokens) {
    // A token may span a word boundary ("… readings" arrives as " readings"):
    // split on whitespace, flushing the word in progress at each gap.
    const parts = token.split(/(\s+)/);
    for (const part of parts) {
      if (part === "") {
        continue;
      }
      if (/^\s+$/.test(part)) {
        flush();
      } else {
        wordText += part;
        worst = Math.min(worst, logprob);
      }
    }
  }
  flush();
  // Sanity: the folded words must reassemble the transcript's words, or the
  // labeling would lie — degrade to no words instead.
  const rebuilt = words.map((w) => w.text).join(" ");
  const normalized = text.trim().split(/\s+/).join(" ");
  return rebuilt === normalized ? words : undefined;
}

export function closeSuffix(code?: number, reason?: string): string {
  const trimmed = reason?.trim() ?? "";
  if (code === undefined && trimmed === "") {
    return "";
  }
  if (code === undefined) {
    return ` (${trimmed})`;
  }
  return trimmed === "" ? ` (${code})` : ` (${code}: ${trimmed})`;
}

/**
 * The slice of `ws`'s `unexpected-response` event this module reads — the
 * request (to abort) and a readable response with a status code. Structural,
 * so the unit test drives it with plain emitters instead of a real socket.
 */
export interface UnexpectedResponseSource {
  on(
    event: "unexpected-response",
    listener: (
      request: { destroy(): void },
      response: {
        statusCode?: number | undefined;
        on(event: "data", listener: (chunk: Buffer) => void): unknown;
        on(event: "end", listener: () => void): unknown;
      },
    ) => void,
  ): unknown;
}

/**
 * Attach a `ws` `unexpected-response` listener that reads the rejected
 * handshake's HTTP status and body and reports them through `onError`. Without
 * a listener, `ws` reduces a rejected upgrade to `"Unexpected server response:
 * 403"` — discarding the response body where the API states the actual problem.
 * The body is capped (these are small JSON error payloads) and parsed when it
 * is JSON so the structured form rides `onError`'s `data`.
 */
export function captureUnexpectedResponse(
  ws: UnexpectedResponseSource,
  handlers: RealtimeSocketHandlers,
): void {
  ws.on("unexpected-response", (request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      if (size < 4096) {
        chunks.push(chunk);
        size += chunk.length;
      }
    });
    response.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8").slice(0, 4096).trim();
      let data: unknown = body === "" ? undefined : body;
      let summary = body;
      try {
        const parsed = JSON.parse(body) as { error?: { message?: unknown } };
        data = parsed;
        if (typeof parsed?.error?.message === "string") {
          summary = parsed.error.message;
        }
      } catch {
        // not JSON — the raw (capped) text is still better than nothing
      }
      handlers.onError(
        `upstream rejected the connection (HTTP ${response.statusCode})${summary ? `: ${summary}` : ""}`,
        data,
      );
      request.destroy();
    });
  });
}

/** Builds the upstream socket for one session (real `ws` in prod, a fake in tests). */
export type RealtimeSocketFactory = (
  url: string,
  apiKey: string,
  handlers: RealtimeSocketHandlers,
) => RealtimeSocket;

export interface RealtimeSessionOptions {
  apiKey: string;
  /** Resolves the transcription model at open time. */
  model: () => string;
  /** Resolves the `delay` knob (undefined / "" → omitted). */
  delay?: () => string | undefined;
  /** Override the endpoint (tests). */
  url?: string;
  /** Injected upstream socket (tests); defaults to the real `ws` factory. */
  socketFactory?: RealtimeSocketFactory;
  /** Injected clock (tests); defaults to `Date.now`. */
  now?: () => number;
}

/**
 * A live per-thread realtime transcription session. Audio streams in by segment
 * ordinal; deltas/finals come back through the {@link RealtimeCallbacks}.
 */
export interface RealtimeSession {
  /** Append one PCM16 frame of `segment` (base64-encoded and forwarded upstream). */
  appendAudio(segment: number, bytes: Uint8Array): void;
  /** Commit `segment` (talk-end): its buffer is transcribed as one item. */
  commit(segment: number): void;
  /**
   * Drop `segment` without transcribing it — an accidental tap whose buffer is
   * under the upstream's 100 ms commit minimum. Clears the upstream input
   * buffer (so the stray frames can't prepend to the next segment) and unbinds
   * anything a pre-commit delta may have bound to it.
   */
  discard(segment: number): void;
  /**
   * Resolve once every committed-but-not-completed segment has produced its
   * final, or `timeoutMs` elapses — whichever first. Returns the ordinals still
   * outstanding at timeout (so the caller can finalize them loudly). Used at
   * `fin`, where the compose needs the transcripts that are still in flight.
   */
  drain(timeoutMs: number): Promise<number[]>;
  /** Close the upstream socket (idempotent). */
  close(): void;
}

const textDecoderBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/**
 * The real upstream factory: a `ws` WebSocket to OpenAI, bearer-authed (GA shape
 * — no `OpenAI-Beta` header). Server-side only; the channel always runs under
 * Node, where `ws` is a dependency (same import as `client.ts`).
 */
export const openaiRealtimeSocketFactory: RealtimeSocketFactory = (url, apiKey, handlers) => {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
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
 * Open a realtime transcription session. Eagerly connects (the caller opens it
 * at thread-open so the handshake overlaps the arm→talk gap); audio queued
 * before `session.updated` is flushed once the session is ready.
 */
export function openRealtimeSession(
  options: RealtimeSessionOptions,
  callbacks: RealtimeCallbacks,
): RealtimeSession {
  const now = options.now ?? Date.now;
  const factory = options.socketFactory ?? openaiRealtimeSocketFactory;
  const url = options.url ?? OPENAI_REALTIME_URL;

  let ready = false;
  let dead = false;
  const outbox: string[] = [];

  // Committed segments awaiting a `…completed`, in commit order.
  const pending: number[] = [];
  // Committed segments not yet bound to an upstream item_id, in commit order.
  const awaitingItem: number[] = [];
  // The segment whose audio is streaming right now (appending, not yet
  // committed) — where a pre-commit delta's unseen item_id binds.
  let streamingSegment: number | undefined;
  // Segments already bound to an item_id (until their `…completed`), so a
  // second upstream item can never claim one — and commit() knows not to
  // re-offer a pre-commit-bound segment via awaitingItem.
  const boundSegments = new Set<number>();
  const commitAt = new Map<number, number>();
  const itemToSegment = new Map<string, number>();
  const cumulativeByItem = new Map<string, string>();
  // Items whose segment was discarded (a Space tap): late upstream events for
  // them must drop, never re-bind to whatever segment streams next.
  const discardedItems = new Set<string>();
  const drainWaiters: Array<() => void> = [];

  const settleDrainIfIdle = (): void => {
    if (pending.length === 0) {
      for (const resolve of drainWaiters.splice(0)) {
        resolve();
      }
    }
  };

  // Audio (append/commit) waits for `session.updated`; the config handshake that
  // *produces* that readiness must go out immediately, so it bypasses the queue.
  const sendAudioMessage = (message: object): void => {
    const text = JSON.stringify(message);
    if (ready && !dead) {
      socket.send(text);
    } else if (!dead) {
      outbox.push(text);
    }
  };

  /**
   * Bind an unseen upstream item to its segment: the oldest still-unbound
   * committed segment first (items are created in buffer = commit order), and
   * with none committed, the segment streaming audio right now — the GA models
   * emit partials while audio is still appending, before any commit, and those
   * deltas are exactly what makes the preview stream as you talk.
   */
  const segmentForItem = (itemId: string): number | undefined => {
    if (discardedItems.has(itemId)) {
      return undefined;
    }
    const existing = itemToSegment.get(itemId);
    if (existing !== undefined) {
      return existing;
    }
    // An unseen item with every candidate segment already bound is the OpenAI
    // analogue of Scribe's self-commit: the vendor opened a SECOND transcription
    // item inside one of our segments. `turn_detection: null` is supposed to make
    // that impossible — but Scribe's `commit_strategy=manual` was supposed to as
    // well, and it did not exist. Callers see this as an `orphan-result`, so if
    // it ever happens we learn from a trace instead of from a lost transcript.
    const segment = awaitingItem.shift() ?? (dead ? undefined : streamingSegment);
    if (segment === undefined || boundSegments.has(segment)) {
      return undefined;
    }
    itemToSegment.set(itemId, segment);
    boundSegments.add(segment);
    return segment;
  };

  const completeSegment = (segment: number, itemId: string, result: RealtimeResult): void => {
    const index = pending.indexOf(segment);
    if (index >= 0) {
      pending.splice(index, 1);
    }
    commitAt.delete(segment);
    itemToSegment.delete(itemId);
    cumulativeByItem.delete(itemId);
    boundSegments.delete(segment);
    callbacks.onFinal(segment, result);
    settleDrainIfIdle();
  };

  /** Session-wide fault: finalize every outstanding segment loudly, then idle. */
  const fail = (message: string): void => {
    dead = true;
    const outstanding = pending.splice(0);
    awaitingItem.length = 0;
    for (const segment of outstanding) {
      commitAt.delete(segment);
      callbacks.onError(message, segment);
    }
    if (outstanding.length === 0) {
      callbacks.onError(message);
    }
    settleDrainIfIdle();
  };

  const handleMessage = (text: string): void => {
    let message: { type?: string; item_id?: string; delta?: string; transcript?: string } & {
      error?: { message?: string };
    };
    try {
      message = JSON.parse(text);
    } catch {
      return; // a malformed upstream frame — ignore rather than crash the thread
    }
    switch (message.type) {
      case "session.updated": {
        ready = true;
        // The server's own report of the config it applied. Absence of an error
        // is not proof a param took effect — read the echo (see the ElevenLabs
        // `commit_strategy` post-mortem in elevenlabs-realtime.ts).
        const session = (message as { session?: unknown }).session;
        if (session && typeof session === "object") {
          callbacks.onDiagnostic?.({
            kind: "config-echo",
            config: session as Record<string, unknown>,
          });
          const mismatches = checkRealtimeConfigEcho(
            { model: options.model(), turnDetection: null },
            session,
          );
          for (const m of mismatches) {
            callbacks.onDiagnostic?.({ kind: "config-mismatch", ...m });
          }
        }
        for (const queued of outbox.splice(0)) {
          socket.send(queued);
        }
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const itemId = message.item_id ?? "";
        // Accumulate BEFORE the binding check: a delta with no segment to bind
        // to must still contribute its text, or the first bindable delta (and
        // the `…completed` fallback text) would start from a truncated tail.
        const cumulative = (cumulativeByItem.get(itemId) ?? "") + (message.delta ?? "");
        cumulativeByItem.set(itemId, cumulative);
        const segment = segmentForItem(itemId);
        if (segment === undefined) {
          return;
        }
        callbacks.onDelta(segment, cumulative);
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const itemId = message.item_id ?? "";
        const segment = segmentForItem(itemId);
        if (segment === undefined) {
          // A finished transcript that matched no segment — never silent again.
          callbacks.onDiagnostic?.({
            kind: "orphan-result",
            messageType: message.type,
            chars: (message.transcript ?? "").length,
          });
          return;
        }
        const started = commitAt.get(segment) ?? now();
        // GA `…completed` events may carry usage (audio tokens dominate);
        // price per segment when they do, tolerate their absence.
        const usage = usageFromTranscription((message as { usage?: unknown }).usage);
        const text = message.transcript ?? cumulativeByItem.get(itemId) ?? "";
        const words = wordsFromTokenLogprobs(text, (message as { logprobs?: unknown }).logprobs);
        completeSegment(segment, itemId, {
          text,
          latencyMs: Math.max(0, now() - started),
          model: options.model(),
          ...(usage ? { cost: priceCall("openai", options.model(), usage) } : {}),
          ...(words !== undefined ? { words } : {}),
        });
        return;
      }
      case "conversation.item.input_audio_transcription.failed": {
        // A REAL OpenAI event this module never handled: the segment's audio was
        // received but transcription failed. Unhandled, it left the segment in
        // `pending` until the drain timeout, indistinguishable from silence.
        // Attribute it to its segment so the caller can finalize that one loudly.
        const itemId = message.item_id ?? "";
        const segment = segmentForItem(itemId);
        const reason = message.error?.message ?? "transcription failed";
        if (segment === undefined) {
          callbacks.onError(reason);
          return;
        }
        const index = pending.indexOf(segment);
        if (index >= 0) {
          pending.splice(index, 1);
        }
        commitAt.delete(segment);
        itemToSegment.delete(itemId);
        cumulativeByItem.delete(itemId);
        boundSegments.delete(segment);
        callbacks.onError(reason, segment);
        settleDrainIfIdle();
        return;
      }
      case "error": {
        fail(message.error?.message ?? "realtime session error");
        return;
      }
      default:
        // Not a bare `return`. Everything this session does not understand is
        // reported — the habit that would have caught Scribe's self-commits.
        callbacks.onDiagnostic?.({
          kind: "unhandled",
          messageType: message.type ?? "(none)",
          raw: text.slice(0, 500),
        });
        return;
    }
  };

  const socket = factory(url, options.apiKey, {
    onOpen: () => {
      const delay = options.delay?.();
      const model = options.model();
      const transcription: Record<string, unknown> = { model };
      // `delay` is a gpt-realtime-whisper-ONLY knob: the 4o-transcribe models
      // over this same wire reject it ("The 'delay' parameter is not
      // supported for this model"), and OpenAI also rejects an empty value —
      // include it only for the model that supports it, and only when set.
      if (model === "gpt-realtime-whisper" && typeof delay === "string" && delay !== "") {
        transcription.delay = delay;
      }
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription,
                turn_detection: null,
              },
            },
            // Token-level confidence on every completed transcript — the
            // preview's heat map consumes it (folded to word level below).
            // No timestamps on this wire; word timing stays vendor-absent.
            include: ["item.input_audio_transcription.logprobs"],
          },
        }),
      );
    },
    onMessage: handleMessage,
    onError: (message) => fail(message),
    onClose: (code, reason) => {
      // A clean close after a drain finds nothing pending (a no-op fail). A close
      // mid-flight finalizes the outstanding segments loudly — with the vendor's
      // close reason, which is where the actual error text lives.
      if (!dead) {
        fail(`realtime session closed${closeSuffix(code, reason)}`);
      }
    },
  });

  return {
    appendAudio(segment, bytes) {
      if (dead) {
        return;
      }
      // Segment ordinal isn't carried upstream (the buffer is implicit) — it
      // marks this segment as the streaming one, where a pre-commit delta's
      // unseen item_id binds. Append forwards bytes as-is.
      streamingSegment = segment;
      sendAudioMessage({ type: "input_audio_buffer.append", audio: textDecoderBase64(bytes) });
    },
    commit(segment) {
      if (dead) {
        callbacks.onError("realtime session unavailable", segment);
        return;
      }
      if (streamingSegment === segment) {
        streamingSegment = undefined; // committed — no longer the pre-commit bind target
      }
      commitAt.set(segment, now());
      pending.push(segment);
      if (!boundSegments.has(segment)) {
        awaitingItem.push(segment); // pre-commit deltas may have bound it already
      }
      sendAudioMessage({ type: "input_audio_buffer.commit" });
    },
    discard(segment) {
      if (streamingSegment === segment) {
        streamingSegment = undefined;
      }
      boundSegments.delete(segment);
      for (const [itemId, bound] of itemToSegment) {
        if (bound === segment) {
          itemToSegment.delete(itemId);
          cumulativeByItem.delete(itemId);
          discardedItems.add(itemId);
        }
      }
      if (!dead) {
        sendAudioMessage({ type: "input_audio_buffer.clear" });
      }
    },
    drain(timeoutMs) {
      if (pending.length === 0) {
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
          resolve([...pending]);
        };
        const timer = setTimeout(finish, timeoutMs);
        drainWaiters.push(finish);
      });
    },
    close() {
      dead = true;
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
