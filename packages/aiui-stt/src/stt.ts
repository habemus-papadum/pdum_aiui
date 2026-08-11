/**
 * stt.ts — `createStt`: the component's handle over one transport, shaped
 * like the pencil (start a session, feed it audio, watch text deltas, know
 * when a segment is final). Push-to-talk first (proposal D2): the CLIENT
 * owns the segment boundary — `beginSegment` → frames → `endSegment` — and
 * ordinals are stamped here so a caller never invents one.
 *
 * What the handle adds over the raw {@link SttConnection}:
 *
 *  - **The credential gap is bridged.** `open()` is async (a mint round-trip
 *    stands between "the user pressed talk" and "a socket exists"), so ops
 *    issued while connecting are queued locally and flushed in order once
 *    the connection resolves — "hold the key and talk immediately" loses
 *    nothing. (Post-connection, the engines' own ready gates buffer until
 *    the vendor's ready signal; this queue covers only the mint window.)
 *  - **Audio is pumped, not plumbed.** With an injected {@link AudioSource}
 *    the handle routes frames to the OPEN segment and drops them between
 *    segments (the mic stays warm; push-to-talk gates what is sent). With
 *    no source, the caller feeds `appendAudio` itself.
 *  - **One observable event stream.** Callbacks fan out to the creation-time
 *    `callbacks` AND to `subscribe`rs — the seam `sttSignals` builds on.
 */

import type {
  AudioSource,
  SttCallbacks,
  SttConnection,
  SttEvent,
  SttStatus,
  SttTransport,
} from "./types";

export interface CreateSttOptions {
  transport: SttTransport;
  /** Absent = the caller appends PCM itself ({@link SttHandle.appendAudio}). */
  audio?: AudioSource;
  /** Creation-time observers; `subscribe` is the dynamic alternative. */
  callbacks?: Partial<SttCallbacks>;
}

export interface SttHandle {
  /** The transport's advertised surface (word timestamps, keyterms, …). */
  readonly transport: SttTransport;
  /**
   * Mint a credential and open the vendor session. Idempotent while a
   * connection is live or in flight. Called implicitly by `beginSegment`,
   * but calling it eagerly (at UI-arm time) overlaps the mint+handshake
   * with the human's arm→talk gap — the channel's own pattern.
   */
  connect(): Promise<void>;
  /** Begin a push-to-talk segment; returns its ordinal. Auto-connects. */
  beginSegment(): number;
  /** Commit the open segment (talk-end): its audio becomes one transcript. */
  endSegment(): void;
  /** Drop the open segment (an accidental tap) without transcribing it. */
  cancelSegment(): void;
  /** Feed one PCM16 frame to the open segment (the no-AudioSource path). */
  appendAudio(bytes: Uint8Array): void;
  /** Resolve when every committed segment has finaled (or timeout, returning
   * the ordinals still outstanding). */
  drain(timeoutMs?: number): Promise<number[]>;
  /** Close the session and stop the audio source. */
  close(): void;
  status(): SttStatus;
  subscribe(listener: (event: SttEvent) => void): () => void;
}

/** Ops queued during the mint window, flushed in order on connect. */
type QueuedOp =
  | { op: "append"; segment: number; bytes: Uint8Array }
  | { op: "commit"; segment: number }
  | { op: "discard"; segment: number };

export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export function createStt(options: CreateSttOptions): SttHandle {
  const listeners = new Set<(event: SttEvent) => void>();
  let status: SttStatus = "idle";
  let connection: SttConnection | undefined;
  let connecting: Promise<void> | undefined;
  let nextSegment = 0;
  let openSegment: number | undefined;
  let audioStarted = false;
  const queue: QueuedOp[] = [];

  const emit = (event: SttEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  const setStatus = (next: SttStatus): void => {
    if (status === next) {
      return;
    }
    status = next;
    emit({ type: "status", status: next });
  };

  // The one callbacks object handed to the transport: fan out to the
  // creation-time observers and the subscribers.
  const callbacks: SttCallbacks = {
    onDelta(segment, cumulativeText) {
      options.callbacks?.onDelta?.(segment, cumulativeText);
      emit({ type: "delta", segment, text: cumulativeText });
    },
    onFinal(segment, result) {
      options.callbacks?.onFinal?.(segment, result);
      emit({ type: "final", segment, result });
    },
    onError(message, segment) {
      options.callbacks?.onError?.(message, segment);
      emit({ type: "error", message, ...(segment !== undefined ? { segment } : {}) });
    },
    onDiagnostic(diagnostic) {
      options.callbacks?.onDiagnostic?.(diagnostic);
      emit({ type: "diagnostic", diagnostic });
    },
  };

  const routeFrame = (bytes: Uint8Array): void => {
    // Between segments the mic stays warm but nothing is sent — push-to-talk
    // gates the wire, not the capture.
    if (openSegment === undefined || status === "closed" || status === "error") {
      return;
    }
    if (connection !== undefined) {
      connection.appendAudio(openSegment, bytes);
    } else {
      queue.push({ op: "append", segment: openSegment, bytes });
    }
  };

  const ensureAudio = (): void => {
    if (options.audio === undefined || audioStarted) {
      return;
    }
    audioStarted = true;
    options.audio.start(routeFrame).catch((error) => {
      audioStarted = false;
      callbacks.onError(`audio source failed to start: ${String(error)}`);
    });
  };

  const connect = (): Promise<void> => {
    if (connection !== undefined) {
      return Promise.resolve();
    }
    if (connecting !== undefined) {
      return connecting;
    }
    setStatus("connecting");
    connecting = options.transport
      .open(callbacks)
      .then((opened) => {
        connecting = undefined;
        connection = opened;
        setStatus("ready");
        for (const queued of queue.splice(0)) {
          if (queued.op === "append") {
            opened.appendAudio(queued.segment, queued.bytes);
          } else if (queued.op === "commit") {
            opened.commit(queued.segment);
          } else {
            opened.discard(queued.segment);
          }
        }
      })
      .catch((error) => {
        connecting = undefined;
        setStatus("error");
        // Ops queued against the failed connect can never complete — settle
        // their segments loudly, in order, so no preview waits forever.
        const stuck = queue.splice(0);
        const message = `stt transport failed to open: ${String(error)}`;
        const seen = new Set<number>();
        for (const queued of stuck) {
          if (queued.op === "commit" && !seen.has(queued.segment)) {
            seen.add(queued.segment);
            callbacks.onError(message, queued.segment);
          }
        }
        callbacks.onError(message);
        throw error;
      });
    return connecting;
  };

  return {
    transport: options.transport,
    connect() {
      // Callers who fire-and-forget an eager connect still get the error
      // through callbacks; the rejection here is for those who await.
      return connect();
    },
    beginSegment() {
      if (openSegment !== undefined) {
        // Two overlapping segments cannot exist under push-to-talk; end the
        // stale one the way a key-up would have.
        this.endSegment();
      }
      const segment = nextSegment++;
      openSegment = segment;
      ensureAudio();
      if (connection === undefined) {
        connect().catch(() => {
          // reported through callbacks above
        });
      }
      return segment;
    },
    endSegment() {
      if (openSegment === undefined) {
        return;
      }
      // The tail first: a warm source holds up to a frame of buffered audio,
      // and the commit must cover the last thing the user said.
      options.audio?.flush?.();
      const segment = openSegment;
      openSegment = undefined;
      if (connection !== undefined) {
        connection.commit(segment);
      } else {
        queue.push({ op: "commit", segment });
      }
    },
    cancelSegment() {
      if (openSegment === undefined) {
        return;
      }
      const segment = openSegment;
      openSegment = undefined;
      if (connection !== undefined) {
        connection.discard(segment);
      } else {
        // Everything queued for this segment dies with it — including its
        // frames, which must never prepend to the next segment.
        for (let i = queue.length - 1; i >= 0; i--) {
          if (queue[i].segment === segment) {
            queue.splice(i, 1);
          }
        }
        queue.push({ op: "discard", segment });
      }
    },
    appendAudio(bytes) {
      routeFrame(bytes);
    },
    drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS) {
      return connection?.drain(timeoutMs) ?? Promise.resolve([]);
    },
    close() {
      openSegment = undefined;
      queue.length = 0;
      if (audioStarted) {
        options.audio?.stop();
        audioStarted = false;
      }
      connection?.close();
      connection = undefined;
      setStatus("closed");
    },
    status() {
      return status;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
