/**
 * `aiui native-host` — the Chrome native-messaging host (browser-extension
 * proposal §4): a thin stdio shim the browser spawns to answer what an
 * extension cannot learn on its own — the on-disk channel registry
 * (`~/.cache/aiui/mcp/<pid>.json`), read through the same `listMcpServers()`
 * the CLI's own selectors use.
 *
 * Wire format (Chrome's, exactly): each message is a 32-bit **native-endian**
 * length followed by UTF-8 JSON, both directions, over stdin/stdout. Chrome's
 * `sendNativeMessage` spawns one process per request and reads one reply;
 * `connectNative` keeps the process for a session — this host serves both by
 * simply answering every frame until stdin closes. stdout is sacred (frames
 * only); diagnostics go to stderr, which Chrome folds into its own log.
 *
 * Requests:  { cmd: "listChannels" } | { cmd: "version" } | { cmd: "ping" }
 * Responses: { ok: true, ... } | { ok: false, error }
 */
import { listMcpServers } from "@habemus-papadum/aiui-claude-channel";

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
export function handleNativeRequest(message: unknown): Record<string, unknown> {
  const cmd =
    message !== null && typeof message === "object"
      ? (message as { cmd?: unknown }).cmd
      : undefined;
  if (cmd === "ping") {
    return { ok: true, at: new Date().toISOString() };
  }
  if (cmd === "version") {
    return { ok: true, version: 1 };
  }
  if (cmd === "listChannels") {
    const channels = listMcpServers().map((server) => ({
      tag: server.tag,
      port: server.port,
      pid: server.pid,
      cwd: server.cwd,
      startedAt: server.startedAt,
      ...(server.name !== undefined ? { name: server.name } : {}),
      ...(server.debug === true ? { debug: true } : {}),
    }));
    return { ok: true, channels };
  }
  return { ok: false, error: `unknown cmd ${JSON.stringify(cmd)}` };
}

/** The stdio loop. Never resolves until stdin ends (Chrome closes it). */
export async function runNativeHost(): Promise<void> {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const { messages, rest } = decodeNativeFrames(pending);
    pending = rest;
    for (const message of messages) {
      let response: Record<string, unknown>;
      try {
        response = handleNativeRequest(message);
      } catch (err) {
        response = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      process.stdout.write(encodeNativeFrame(response));
    }
  });
  await new Promise<void>((resolve) => {
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
  });
}
