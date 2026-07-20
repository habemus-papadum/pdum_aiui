/**
 * The Chrome native-messaging host: a thin stdio shim over the enriched
 * listing, answering what an extension cannot learn on its own (an extension
 * page's origin is `chrome-extension://…`, so it can't read the on-disk
 * registry). Framing is Chrome's, exactly: each message is a 32-bit
 * **native-endian** length followed by UTF-8 JSON, both directions, over
 * stdin/stdout. Chrome's `sendNativeMessage` spawns one process per request;
 * `connectNative` keeps it for a session — this host serves both by answering
 * every frame until stdin closes. stdout is sacred (frames only); diagnostics
 * go to stderr, which Chrome folds into its own log.
 *
 * Every response carries `protocol` (docs/proposals/aiui-registry.md §8) so
 * the extension can detect a too-old host and tell the user, instead of
 * misbehaving.
 *
 * Requests:  { cmd: "listChannels" } | { cmd: "version" } | { cmd: "ping" }
 * Responses: { ok: true, protocol, ... } | { ok: false, protocol, error }
 */
import type { ChannelListing } from "./types.ts";
import { PROTOCOL } from "./types.ts";

/** Encode one native-messaging frame (native-endian u32 length + JSON). Pure. */
export function encodeNativeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  // Native byte order, per the protocol. Node has no writeUInt32NE; use the
  // platform's endianness explicitly (every supported desktop is LE today).
  if (isLittleEndian()) {
    frame.writeUInt32LE(body.length, 0);
  } else {
    frame.writeUInt32BE(body.length, 0);
  }
  body.copy(frame, 4);
  return frame;
}

/**
 * Split complete frames off an accumulating buffer. Returns the parsed
 * messages and the unconsumed remainder (a partial frame stays buffered).
 * Unparseable JSON inside a complete frame yields `undefined` in its slot —
 * the caller answers with an error rather than dying. Pure.
 */
export function decodeNativeFrames(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = isLittleEndian() ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    if (buffer.length - offset - 4 < length) {
      break;
    }
    const body = buffer.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
    try {
      messages.push(JSON.parse(body.toString("utf8")));
    } catch {
      messages.push(undefined);
    }
  }
  return { messages, rest: buffer.subarray(offset) };
}

function isLittleEndian(): boolean {
  return new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
}

/** Answer one request. Exported for tests. */
export function handleNativeRequest(
  message: unknown,
  list: () => ChannelListing,
): Record<string, unknown> {
  const cmd =
    message !== null && typeof message === "object"
      ? (message as { cmd?: unknown }).cmd
      : undefined;
  if (cmd === "ping") {
    return { ok: true, protocol: PROTOCOL, at: new Date().toISOString() };
  }
  if (cmd === "version") {
    return { ok: true, protocol: PROTOCOL };
  }
  if (cmd === "listChannels") {
    // The listing already carries `protocol` — spread keeps one source of truth.
    return { ok: true, ...list() };
  }
  return { ok: false, protocol: PROTOCOL, error: `unknown cmd ${JSON.stringify(cmd)}` };
}

/** What {@link runNativeHost} needs; streams are injectable for tests. */
export interface HostOptions {
  list: () => ChannelListing;
  input?: NodeJS.ReadableStream;
  output?: { write(chunk: Buffer): unknown };
}

/** The stdio loop. Never resolves until stdin ends (Chrome closes it). */
export async function runNativeHost(options: HostOptions): Promise<void> {
  const input: NodeJS.ReadableStream = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let pending: Buffer = Buffer.alloc(0);
  input.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const { messages, rest } = decodeNativeFrames(pending);
    pending = rest;
    for (const message of messages) {
      let response: Record<string, unknown>;
      try {
        response = handleNativeRequest(message, options.list);
      } catch (err) {
        response = {
          ok: false,
          protocol: PROTOCOL,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      output.write(encodeNativeFrame(response));
    }
  });
  await new Promise<void>((resolve) => {
    input.on("end", resolve);
    input.on("close", resolve);
  });
}
