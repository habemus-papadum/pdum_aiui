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
import { decodeFrame, type Envelope, type HelloMeta } from "./frame";

/** Push text into the Claude Code session (the channel notification). */
export type SendPrompt = (text: string) => void | Promise<void>;

/** What a processor can see and do for the one thread it owns. */
export interface ThreadContext {
  /** The client-generated id of this thread. */
  threadId: string;
  /** The client context from the connection's hello (tab, source), if sent. */
  hello?: HelloMeta;
  /** Push text into the Claude Code session. */
  sendPrompt: SendPrompt;
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
}

/** Consumes the decoded message payloads of a single thread. */
export interface StreamProcessor {
  /**
   * Handle one decoded payload. Calls are serialized in arrival order — an
   * async handler never overlaps the thread's (or connection's) next frame.
   * Throwing rejects that frame (`ok: false`) without closing the thread.
   */
  onMessage(payload: unknown, meta: MessageMeta): void | Promise<void>;
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
}

/** The protocol state of one client connection. */
export interface ChannelConnection {
  /**
   * Handle one raw binary frame from the client, resolving with the reply to
   * send back. Frames are processed strictly in call order, one at a time.
   */
  handleFrame(frame: Uint8Array): Promise<ChannelResponse>;
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
        close: () => {
          threads.delete(threadId);
          closed.add(threadId);
        },
      });
      threads.set(threadId, processor);
    }
    try {
      await processor.onMessage(decoded, { fin: envelope.fin === true });
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

  return { handleFrame };
}
