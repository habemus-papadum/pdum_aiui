/**
 * The realtime transcription seam — server-side, and since the REST
 * retirement (2026-07-18) the only OpenAI transcription path.
 *
 * Where the retired REST path was one blob in → one timed transcript out,
 * this holds a **per-thread WebSocket** to OpenAI's realtime transcription
 * endpoint and streams a segment's PCM *while you talk*:
 * `input_audio_buffer.append` per frame, `input_audio_buffer.commit` at
 * talk-end, partial `…delta` events echoed back as they arrive, a
 * `…completed` event as the segment's final (archive/streaming-turns.md §3).
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
import { type CallCost, priceCall, usageFromTranscription } from "./cost";
import { toBase64 } from "./pcm";
import {
  closeSuffix,
  createDrainController,
  createReadyGate,
  makeWsSocketFactory,
  type RealtimeDiagnostic,
  type RealtimeSocketFactory,
  reportSessionFailure,
} from "./session-core";

// The socket primitives moved to session-core.ts, but three sibling sessions and
// the root barrel still import them from here — re-export so those paths hold.
export {
  captureUnexpectedResponse,
  closeSuffix,
  type RealtimeDiagnostic,
  type RealtimeSocket,
  type RealtimeSocketFactory,
  type RealtimeSocketHandlers,
  type UnexpectedResponseSource,
} from "./session-core";

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

/**
 * The real upstream factory: a `ws` WebSocket to OpenAI, bearer-authed (GA shape
 * — no `OpenAI-Beta` header). Server-side only; the channel always runs under
 * Node, where `ws` is a dependency (same import as `client.ts`).
 */
export const openaiRealtimeSocketFactory: RealtimeSocketFactory = makeWsSocketFactory(
  (url, apiKey) => ({ url, headers: { Authorization: `Bearer ${apiKey}` } }),
);

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

  const gate = createReadyGate((text) => socket.send(text));

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
  // Outstanding = every committed-but-not-completed segment, snapshotted at drain
  // resolution time.
  const drainCtl = createDrainController(() => [...pending]);

  // Audio (append/commit) waits for `session.updated`; the config handshake that
  // *produces* that readiness must go out immediately, so it bypasses the queue.
  const sendAudioMessage = (message: object): void => gate.send(JSON.stringify(message));

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
    const segment = awaitingItem.shift() ?? (gate.isDead() ? undefined : streamingSegment);
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
    drainCtl.settleIfIdle();
  };

  /** Session-wide fault: finalize every outstanding segment loudly, then idle. */
  const fail = (message: string): void => {
    gate.markDead();
    const outstanding = pending.splice(0);
    awaitingItem.length = 0;
    for (const segment of outstanding) {
      commitAt.delete(segment); // per-twin teardown: clear each segment's commit clock
    }
    reportSessionFailure(callbacks.onError, message, outstanding);
    drainCtl.settleIfIdle();
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
        gate.markReady();
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
        drainCtl.settleIfIdle();
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
      // Segment ordinal isn't carried upstream (the buffer is implicit) — it
      // marks this segment as the streaming one, where a pre-commit delta's
      // unseen item_id binds. Append forwards bytes as-is.
      streamingSegment = segment;
      sendAudioMessage({ type: "input_audio_buffer.append", audio: toBase64(bytes) });
    },
    commit(segment) {
      if (gate.isDead()) {
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
      if (!gate.isDead()) {
        sendAudioMessage({ type: "input_audio_buffer.clear" });
      }
    },
    drain(timeoutMs) {
      return drainCtl.drain(timeoutMs);
    },
    close() {
      gate.markDead();
      try {
        socket.close();
      } catch {
        // best-effort — the socket may already be closing
      }
      // Release any drain still waiting so `fin` never hangs on a closed socket.
      drainCtl.releaseAll();
    },
  };
}
