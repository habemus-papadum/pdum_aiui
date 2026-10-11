/** Explicit dictation segments over an injected audio subscription and Scribe connection. */
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
  audio?: AudioSource;
  callbacks?: Partial<SttCallbacks>;
}
export interface SttHandle {
  readonly transport: SttTransport;
  connect(): Promise<void>;
  beginSegment(): number;
  /** Await the audio fence before reading the transcript or beginning the next segment. */
  endSegment(): Promise<void>;
  cancelSegment(): void;
  appendAudio(bytes: Uint8Array): void;
  drain(timeoutMs?: number): Promise<number[]>;
  close(): void;
  status(): SttStatus;
  subscribe(listener: (event: SttEvent) => void): () => void;
}
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
type QueuedOp =
  | { op: "append"; segment: number; bytes: Uint8Array }
  | { op: "commit"; segment: number };

export function createStt(options: CreateSttOptions): SttHandle {
  const listeners = new Set<(event: SttEvent) => void>();
  const pending = new Set<number>();
  const waiters = new Set<() => void>();
  let state: SttStatus = "idle";
  let connection: SttConnection | undefined;
  let connecting: Promise<void> | undefined;
  let opening: SttConnection | undefined;
  let audioGeneration = 0;
  let generation = 0;
  let ordinal = 0;
  let segment: number | undefined;
  let ending: Promise<void> | undefined;
  let audioStarted = false;
  const queue: QueuedOp[] = [];
  const emit = (event: SttEvent) => {
    for (const listener of listeners) listener(event);
  };
  const status = (next: SttStatus) => {
    if (state !== next) {
      state = next;
      emit({ type: "status", status: next });
    }
  };
  const settle = (id: number) => {
    pending.delete(id);
    if (!pending.size) for (const finish of [...waiters]) finish();
  };
  const error = (message: string, id?: number) => {
    options.callbacks?.onError?.(message, id);
    emit({ type: "error", message, segment: id });
    if (id !== undefined) settle(id);
  };
  const stopAudio = () => {
    audioGeneration++;
    options.audio?.stop();
    audioStarted = false;
  };
  const fault = (message: string) => {
    generation++;
    connecting = undefined;
    const old = connection;
    connection = undefined;
    old?.close();
    opening?.close();
    opening = undefined;
    segment = undefined;
    queue.length = 0;
    stopAudio();
    status("error");
    for (const id of [...pending]) error(message, id);
    error(message);
  };
  const frame = (bytes: Uint8Array) => {
    if (segment === undefined || state === "closed" || state === "error") return;
    if (connection) connection.appendAudio(segment, bytes);
    else queue.push({ op: "append", segment, bytes: bytes.slice() });
  };
  const connect = (): Promise<void> => {
    if (connection) return Promise.resolve();
    if (connecting) return connecting;
    const epoch = ++generation;
    status("connecting");
    const callbacks: SttCallbacks = {
      onDelta(id, text) {
        if (epoch !== generation) return;
        options.callbacks?.onDelta?.(id, text);
        emit({ type: "delta", segment: id, text });
      },
      onFinal(id, result) {
        if (epoch !== generation) return;
        options.callbacks?.onFinal?.(id, result);
        emit({ type: "final", segment: id, result });
        settle(id);
      },
      onError(message, id) {
        if (epoch === generation) error(message, id);
      },
      onClose(message) {
        if (epoch === generation) fault(message);
      },
      onDiagnostic(diagnostic) {
        if (epoch !== generation) return;
        options.callbacks?.onDiagnostic?.(diagnostic);
        emit({ type: "diagnostic", diagnostic });
      },
    };
    connecting = (async () => {
      let opened: SttConnection | undefined;
      try {
        opened = await options.transport.open(callbacks);
        if (epoch !== generation) {
          opened.close();
          return;
        }
        opening = opened;
        await opened.ready;
        if (opening === opened) opening = undefined;
        if (epoch !== generation) {
          opened.close();
          return;
        }
        connection = opened;
        connecting = undefined;
        status("ready");
        for (const op of queue.splice(0)) {
          if (op.op === "append") opened.appendAudio(op.segment, op.bytes);
          else opened.commit(op.segment);
        }
      } catch (cause) {
        opened?.close();
        if (epoch === generation) fault(`stt transport failed to open: ${String(cause)}`);
        throw cause;
      }
    })();
    return connecting;
  };
  return {
    transport: options.transport,
    connect,
    beginSegment() {
      if (segment !== undefined || ending)
        throw new Error("End and await the current segment before beginning another");
      const id = ordinal++;
      segment = id;
      // Start connection first: it resets a previous error state before source frames arrive.
      void connect().catch(() => {});
      if (options.audio && !audioStarted) {
        audioStarted = true;
        const audioEpoch = ++audioGeneration;
        void options.audio.start(frame).catch((cause) => {
          if (audioEpoch === audioGeneration)
            fault(`audio source failed to start: ${String(cause)}`);
        });
      }
      return id;
    },
    endSegment() {
      if (ending) return ending;
      if (segment === undefined) return Promise.resolve();
      const id = segment,
        epoch = generation;
      pending.add(id);
      ending = (async () => {
        try {
          await options.audio?.flush?.();
          if (epoch !== generation || segment !== id) return;
          segment = undefined;
          stopAudio(); // release the subscription; the shared hub keeps capture warm
          if (connection) connection.commit(id);
          else queue.push({ op: "commit", segment: id });
        } catch (cause) {
          fault(`audio flush failed: ${String(cause)}`);
        } finally {
          ending = undefined;
        }
      })();
      return ending;
    },
    cancelSegment() {
      if (segment === undefined) return;
      const id = segment;
      segment = undefined;
      stopAudio();
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].segment === id) queue.splice(i, 1);
      connection?.discard(id);
      settle(id);
      emit({ type: "delta", segment: id, text: "" });
    },
    appendAudio: frame,
    drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS) {
      if (!pending.size) return Promise.resolve([]);
      return new Promise<number[]>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(finish);
          resolve([...pending]);
        };
        const timer = setTimeout(finish, timeoutMs);
        waiters.add(finish);
      });
    },
    close() {
      generation++;
      segment = undefined;
      queue.length = 0;
      connecting = undefined;
      stopAudio();
      const old = connection;
      connection = undefined;
      old?.close();
      opening?.close();
      opening = undefined;
      for (const id of [...pending]) error("STT session closed", id);
      status("closed");
    },
    status: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
