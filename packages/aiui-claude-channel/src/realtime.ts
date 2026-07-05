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
 *    correlates events for one committed segment.
 *
 * The upstream socket is injectable ({@link RealtimeSocketFactory}) so the unit
 * tests drive a scripted fake session with no network and no key — the same seam
 * pattern as `transcribe.ts`'s injected `fetch`.
 */
import WebSocket from "ws";

/** The verified GA endpoint for a transcription-intent realtime session. */
export const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

/** The default realtime transcription model (a natively-streaming whisper). */
export const DEFAULT_REALTIME_MODEL = "gpt-realtime-whisper";

/** One realtime transcript result (mirrors {@link ./transcribe}.TranscriptResult). */
export interface RealtimeResult {
  text: string;
  /** Wall-clock from the segment's commit (talk-end) to its `…completed`. */
  latencyMs: number;
  model: string;
}

/** What a realtime session reports back, keyed by our own segment ordinal. */
export interface RealtimeCallbacks {
  /** A partial transcript for `segment` — cumulative text (not the raw delta). */
  onDelta(segment: number, cumulativeText: string): void;
  /** The final transcript for `segment`. */
  onFinal(segment: number, result: RealtimeResult): void;
  /**
   * A failure. `segment` names the committed segment it belongs to (so the
   * caller can finalize just that one loudly); undefined for a session-wide
   * fault before any commit.
   */
  onError(message: string, segment?: number): void;
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
  onError(message: string): void;
  onClose(): void;
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
  ws.on("close", () => handlers.onClose());
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
  const commitAt = new Map<number, number>();
  const itemToSegment = new Map<string, number>();
  const cumulativeByItem = new Map<string, string>();
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

  /** Bind an unseen upstream item to the oldest still-unbound committed segment. */
  const segmentForItem = (itemId: string): number | undefined => {
    const existing = itemToSegment.get(itemId);
    if (existing !== undefined) {
      return existing;
    }
    const segment = awaitingItem.shift();
    if (segment === undefined) {
      return undefined;
    }
    itemToSegment.set(itemId, segment);
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
        for (const queued of outbox.splice(0)) {
          socket.send(queued);
        }
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const itemId = message.item_id ?? "";
        const segment = segmentForItem(itemId);
        if (segment === undefined) {
          return;
        }
        const cumulative = (cumulativeByItem.get(itemId) ?? "") + (message.delta ?? "");
        cumulativeByItem.set(itemId, cumulative);
        callbacks.onDelta(segment, cumulative);
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const itemId = message.item_id ?? "";
        const segment = segmentForItem(itemId);
        if (segment === undefined) {
          return;
        }
        const started = commitAt.get(segment) ?? now();
        completeSegment(segment, itemId, {
          text: message.transcript ?? cumulativeByItem.get(itemId) ?? "",
          latencyMs: Math.max(0, now() - started),
          model: options.model(),
        });
        return;
      }
      case "error": {
        fail(message.error?.message ?? "realtime session error");
        return;
      }
      default:
        return;
    }
  };

  const socket = factory(url, options.apiKey, {
    onOpen: () => {
      const delay = options.delay?.();
      const transcription: Record<string, unknown> = { model: options.model() };
      // `delay` is optional and OpenAI rejects an empty value — include it only
      // when the config actually set one of the allowed levels.
      if (typeof delay === "string" && delay !== "") {
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
          },
        }),
      );
    },
    onMessage: handleMessage,
    onError: (message) => fail(message),
    onClose: () => {
      // A clean close after a drain finds nothing pending (a no-op fail). A close
      // mid-flight finalizes the outstanding segments loudly.
      if (!dead) {
        fail("realtime session closed");
      }
    },
  });

  return {
    appendAudio(segment, bytes) {
      if (dead) {
        return;
      }
      // Segment ordinal isn't carried upstream (the buffer is implicit); it is
      // bound to an item_id at commit-order time. Append forwards bytes as-is.
      void segment;
      sendAudioMessage({ type: "input_audio_buffer.append", audio: textDecoderBase64(bytes) });
    },
    commit(segment) {
      if (dead) {
        callbacks.onError("realtime session unavailable", segment);
        return;
      }
      commitAt.set(segment, now());
      pending.push(segment);
      awaitingItem.push(segment);
      sendAudioMessage({ type: "input_audio_buffer.commit" });
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
