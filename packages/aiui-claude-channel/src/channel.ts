/**
 * The websocket channel protocol: connection state machine and processor types.
 *
 * A client connects (no auth), declares the message-stream format it will
 * speak in an initial hello — `{"type": "hello", "format": "<name>"}` — and
 * then streams messages tagged with client-generated thread ids:
 * `{"threadId": "<id>", "payload": ...}`. The connection looks the format up
 * in its {@link ProcessorRegistry}; each new thread id gets its own
 * {@link StreamProcessor} built by that format's factory, and every later
 * payload for the thread is fed to it. A processor decides for itself when its
 * thread is complete (e.g. the client said it's done) and closes it via
 * {@link ThreadContext.close}; any further message naming a closed thread is
 * an error. A connection may run any number of threads, and the server any
 * number of connections.
 *
 * This module is transport-agnostic — raw message strings in, response
 * objects out — so the protocol is unit-testable without a websocket in
 * sight. See web.ts for the wiring.
 */

/** Push text into the Claude Code session (the channel notification). */
export type SendPrompt = (text: string) => void | Promise<void>;

/** What a processor can see and do for the one thread it owns. */
export interface ThreadContext {
  /** The client-generated id of this thread. */
  threadId: string;
  /** Push text into the Claude Code session. */
  sendPrompt: SendPrompt;
  /**
   * Mark this thread closed: the processor is released and any further
   * message naming this thread id is rejected. Idempotent.
   */
  close: () => void;
}

/** Consumes the message payloads of a single thread. */
export interface StreamProcessor {
  /**
   * Handle one message payload. Calls are serialized in arrival order — an
   * async handler never overlaps the thread's (or connection's) next message.
   * Throwing rejects that message (`ok: false`) without closing the thread.
   */
  onMessage(payload: unknown): void | Promise<void>;
}

/** Builds the processor for one new thread. */
export type StreamProcessorFactory = (ctx: ThreadContext) => StreamProcessor;

/**
 * Available stream formats, keyed by the name a client may declare in its
 * hello message.
 */
export type ProcessorRegistry = ReadonlyMap<string, StreamProcessorFactory>;

/** The per-message reply the transport sends back to the client. */
export interface ChannelResponse {
  ok: boolean;
  /** Echo of the message's thread id, when it named one. */
  threadId?: string;
  /** True when this message led the processor to close the thread. */
  closed?: boolean;
  /** What went wrong, when `ok` is false. */
  error?: string;
  /** True when the connection is unusable and the transport should drop it. */
  fatal?: boolean;
}

export interface ChannelConnectionOptions {
  /** The formats this connection may speak; hello must name one of them. */
  processors: ProcessorRegistry;
  /** Where thread processors push prompt text. */
  sendPrompt: SendPrompt;
}

/** The protocol state of one client connection. */
export interface ChannelConnection {
  /**
   * Handle one raw message from the client, resolving with the reply to send
   * back. Messages are processed strictly in call order, one at a time.
   */
  handleMessage(raw: string): Promise<ChannelResponse>;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Create the state machine for one freshly connected client. */
export function createChannelConnection(options: ChannelConnectionOptions): ChannelConnection {
  // Set by a successful hello; its presence is the "hello received" state.
  let factory: StreamProcessorFactory | undefined;
  const threads = new Map<string, StreamProcessor>();
  const closed = new Set<string>();

  const handleHello = (message: unknown): ChannelResponse => {
    if (!isRecord(message) || message.type !== "hello" || typeof message.format !== "string") {
      return {
        ok: false,
        fatal: true,
        error: 'expected an initial hello: {"type": "hello", "format": "<format>"}',
      };
    }
    const found = options.processors.get(message.format);
    if (!found) {
      const known = [...options.processors.keys()].sort().join(", ");
      return {
        ok: false,
        fatal: true,
        error: `unknown format "${message.format}" (known formats: ${known})`,
      };
    }
    factory = found;
    return { ok: true };
  };

  const handleThreadMessage = async (
    message: unknown,
    buildProcessor: StreamProcessorFactory,
  ): Promise<ChannelResponse> => {
    if (!isRecord(message) || typeof message.threadId !== "string" || message.threadId === "") {
      return { ok: false, error: 'expected a message with a non-empty string "threadId"' };
    }
    const threadId = message.threadId;
    if (closed.has(threadId)) {
      return { ok: false, threadId, error: `thread "${threadId}" is closed` };
    }
    let processor = threads.get(threadId);
    if (!processor) {
      processor = buildProcessor({
        threadId,
        sendPrompt: options.sendPrompt,
        close: () => {
          threads.delete(threadId);
          closed.add(threadId);
        },
      });
      threads.set(threadId, processor);
    }
    try {
      await processor.onMessage(message.payload);
    } catch (err) {
      return { ok: false, threadId, error: errorMessage(err) };
    }
    return closed.has(threadId) ? { ok: true, threadId, closed: true } : { ok: true, threadId };
  };

  // Serialize message handling: chain every call on the previous one so an
  // async processor never sees message N+1 before it finished message N.
  let queue: Promise<unknown> = Promise.resolve();
  const handleMessage = (raw: string): Promise<ChannelResponse> => {
    const result = queue.then((): Promise<ChannelResponse> | ChannelResponse => {
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        // Before hello there is no usable connection to salvage.
        return { ok: false, fatal: factory === undefined, error: "message is not valid JSON" };
      }
      return factory === undefined ? handleHello(message) : handleThreadMessage(message, factory);
    });
    queue = result;
    return result;
  };

  return { handleMessage };
}
