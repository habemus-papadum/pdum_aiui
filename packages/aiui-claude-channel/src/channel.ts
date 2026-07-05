/**
 * The websocket channel protocol: connection state machine, formats, and
 * processor types.
 *
 * A client connects (no auth) and sends a binary `hello` frame declaring the
 * stream format it will speak — `{ kind: "hello", format: "<name>" }`. The
 * connection looks the format up in its {@link FormatRegistry}: a format bundles
 * a {@link PayloadCodec} (how to decode this format's payload bytes) with a
 * {@link StreamProcessorFactory} (what to do with the decoded payloads). After
 * hello the client streams `data` frames tagged with client-generated thread
 * ids; each new id gets its own {@link StreamProcessor}, and every later frame
 * for that thread is decoded with the format's codec and handed to it. A frame
 * may set `fin` to mark the thread's last message; the processor decides for
 * itself when to {@link ThreadContext.close}. Any frame naming a closed thread
 * is an error. A connection may run any number of threads, and the server any
 * number of connections.
 *
 * This module is transport-agnostic — it takes raw frame bytes in and returns
 * response objects out — so the protocol is unit-testable without a websocket.
 * See {@link ./frame} for the wire format and web.ts for the wiring.
 */
import type { PayloadCodec } from "./codec";
import { type ChunkDescriptor, decodeFrame, type Envelope, type HelloMeta } from "./frame";

/**
 * Push text into the Claude Code session (the channel notification). The
 * optional `meta` becomes attributes on the rendered `<channel>` tag — the
 * mechanism the `intent-v1` lowering uses to carry Option-C attachment paths
 * (body tokens in the text, `shot_N` → absolute path in meta). Text-only
 * callers (and handlers that ignore the second argument) are unaffected.
 */
export type SendPrompt = (text: string, meta?: Record<string, string>) => void | Promise<void>;

/** Push a server → client message down the same socket (out-of-band of acks). */
export type PushMessage = (message: unknown) => void;

/** What a processor can see and do for the one thread it owns. */
export interface ThreadContext {
  /** The client-generated id of this thread. */
  threadId: string;
  /** The client context from the connection's hello (tab, source), if sent. */
  hello?: HelloMeta;
  /** Push text into the Claude Code session. */
  sendPrompt: SendPrompt;
  /**
   * Push a message back to the connected client, distinct from the per-frame
   * ack (the client tells them apart by a `kind` field). Present only when the
   * transport supports it; `intent-v1` uses it for server-produced `lowered`
   * events (transcripts, correction diffs). Undefined in the pure protocol
   * tests, which never exercise it.
   */
  push?: PushMessage;
  /**
   * Mark this thread closed: the processor is released and any further frame
   * naming this thread id is rejected. Idempotent.
   */
  close: () => void;
}

/** Per-message metadata the framework surfaces alongside the decoded payload. */
export interface MessageMeta {
  /** True when the client marked this the thread's final frame (`fin`). */
  fin: boolean;
  /**
   * The frame's {@link ChunkDescriptor}, when the envelope tagged one (only
   * `intent-v1` frames do). Lets a processor interpret a raw payload without
   * the codec — which never sees the envelope — having to.
   */
  chunk?: ChunkDescriptor;
}

/** Consumes the decoded message payloads of a single thread. */
export interface StreamProcessor {
  /**
   * Handle one decoded payload. Calls are serialized in arrival order — an
   * async handler never overlaps the thread's (or connection's) next frame.
   * Throwing rejects that frame (`ok: false`) without closing the thread.
   */
  onMessage(payload: unknown, meta: MessageMeta): void | Promise<void>;
  /**
   * Optional teardown: the transport connection dropped this thread **without**
   * a `fin` (the socket just closed mid-turn). The processor should release any
   * per-thread resources it holds — an upstream realtime session, incremental
   * caches — and must **not** produce a user-visible side effect (no
   * `sendPrompt`): an abandoned turn lowers to nothing. Never called for a
   * thread that closed itself via {@link ThreadContext.close}. Best-effort — a
   * throw is swallowed so sibling threads still tear down.
   */
  onClose?(): void | Promise<void>;
}

/** Builds the processor for one new thread. */
export type StreamProcessorFactory = (ctx: ThreadContext) => StreamProcessor;

/** A stream format: how to decode its payloads, and what to do with them. */
export interface ChannelFormat {
  /** Decodes this format's payload bytes into what the processor sees. */
  codec: PayloadCodec;
  /** Builds the processor for each new thread of this format. */
  createProcessor: StreamProcessorFactory;
}

/** Available stream formats, keyed by the name a client declares at hello. */
export type FormatRegistry = ReadonlyMap<string, ChannelFormat>;

/** The per-frame reply the transport sends back to the client. */
export interface ChannelResponse {
  ok: boolean;
  /** Echo of the frame's thread id, when it named one. */
  threadId?: string;
  /** True when this frame led the processor to close the thread. */
  closed?: boolean;
  /** What went wrong, when `ok` is false. */
  error?: string;
  /** True when the connection is unusable and the transport should drop it. */
  fatal?: boolean;
}

export interface ChannelConnectionOptions {
  /** The formats this connection may speak; hello must name one of them. */
  formats: FormatRegistry;
  /** Where thread processors push prompt text. */
  sendPrompt: SendPrompt;
  /**
   * Optional server → client push for this connection (see
   * {@link ThreadContext.push}). Handed to every thread's processor; omit it
   * and processors that need it degrade gracefully.
   */
  push?: PushMessage;
}

/** The protocol state of one client connection. */
export interface ChannelConnection {
  /**
   * Handle one raw binary frame from the client, resolving with the reply to
   * send back. Frames are processed strictly in call order, one at a time.
   */
  handleFrame(frame: Uint8Array): Promise<ChannelResponse>;
  /**
   * The transport connection closed. Every thread still open (i.e. one that
   * never `fin`'d) gets its processor's {@link StreamProcessor.onClose}, so
   * per-thread resources are released rather than leaked. Runs after any
   * in-flight frame (it chains on the same serialization queue). Idempotent-ish:
   * a second call simply finds no open threads. Drive it from the transport's
   * connection-close (see web.ts).
   */
  close(): Promise<void>;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Decode a frame, or return the ChannelResponse describing why it couldn't be. */
const parseFrame = (
  frame: Uint8Array,
  helloDone: boolean,
): { envelope: Envelope; payload: Uint8Array } | ChannelResponse => {
  try {
    return decodeFrame(frame);
  } catch (err) {
    // A malformed frame before hello leaves no usable connection to salvage.
    return { ok: false, fatal: !helloDone, error: errorMessage(err) };
  }
};

/** Create the state machine for one freshly connected client. */
export function createChannelConnection(options: ChannelConnectionOptions): ChannelConnection {
  // Set by a successful hello; its presence is the "hello received" state.
  let format: ChannelFormat | undefined;
  // Client context from the hello, handed to every thread's processor.
  let hello: HelloMeta | undefined;
  const threads = new Map<string, StreamProcessor>();
  const closed = new Set<string>();

  const handleHello = (envelope: Envelope): ChannelResponse => {
    if (envelope.kind !== "hello" || typeof envelope.format !== "string") {
      return {
        ok: false,
        fatal: true,
        error: 'expected an initial hello frame: { kind: "hello", format: "<format>" }',
      };
    }
    const found = options.formats.get(envelope.format);
    if (!found) {
      const known = [...options.formats.keys()].sort().join(", ");
      return {
        ok: false,
        fatal: true,
        error: `unknown format "${envelope.format}" (known formats: ${known})`,
      };
    }
    format = found;
    if (envelope.meta !== undefined && typeof envelope.meta === "object") {
      hello = envelope.meta;
    }
    return { ok: true };
  };

  const handleData = async (
    envelope: Envelope,
    payload: Uint8Array,
    activeFormat: ChannelFormat,
  ): Promise<ChannelResponse> => {
    if (
      envelope.kind !== "data" ||
      typeof envelope.threadId !== "string" ||
      envelope.threadId === ""
    ) {
      return { ok: false, error: 'expected a data frame with a non-empty "threadId"' };
    }
    const threadId = envelope.threadId;
    if (closed.has(threadId)) {
      return { ok: false, threadId, error: `thread "${threadId}" is closed` };
    }

    let decoded: unknown;
    try {
      decoded = activeFormat.codec.decode(payload);
    } catch (err) {
      return { ok: false, threadId, error: `payload decode failed: ${errorMessage(err)}` };
    }

    let processor = threads.get(threadId);
    if (!processor) {
      processor = activeFormat.createProcessor({
        threadId,
        ...(hello !== undefined ? { hello } : {}),
        sendPrompt: options.sendPrompt,
        ...(options.push !== undefined ? { push: options.push } : {}),
        close: () => {
          threads.delete(threadId);
          closed.add(threadId);
        },
      });
      threads.set(threadId, processor);
    }
    try {
      await processor.onMessage(decoded, {
        fin: envelope.fin === true,
        ...(envelope.chunk !== undefined ? { chunk: envelope.chunk } : {}),
      });
    } catch (err) {
      return { ok: false, threadId, error: errorMessage(err) };
    }
    return closed.has(threadId) ? { ok: true, threadId, closed: true } : { ok: true, threadId };
  };

  // Serialize frame handling: chain every call on the previous one so an async
  // processor never sees frame N+1 before it finished frame N.
  let queue: Promise<unknown> = Promise.resolve();
  const handleFrame = (frame: Uint8Array): Promise<ChannelResponse> => {
    const result = queue.then((): Promise<ChannelResponse> | ChannelResponse => {
      const parsed = parseFrame(frame, format !== undefined);
      if (!("envelope" in parsed)) {
        return parsed;
      }
      return format === undefined
        ? handleHello(parsed.envelope)
        : handleData(parsed.envelope, parsed.payload, format);
    });
    queue = result;
    return result;
  };

  // Tear down every still-open thread when the connection drops. Chained on the
  // same queue so it runs after the last in-flight frame; each processor's
  // onClose is best-effort so one throwing teardown can't strand the rest.
  const close = (): Promise<void> => {
    const result = queue.then(async () => {
      const live = [...threads.values()];
      threads.clear();
      for (const processor of live) {
        try {
          await processor.onClose?.();
        } catch {
          // best-effort teardown — a leak is better than an unhandled rejection
        }
      }
    });
    queue = result;
    return result;
  };

  return { handleFrame, close };
}
