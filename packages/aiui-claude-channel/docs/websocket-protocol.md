# WebSocket Protocol

Technical reference for the binary `/ws` protocol the channel server speaks. This is
the transport the outside world (a browser overlay, a voice/screenshot tool, a test
harness) uses to push data into a running Claude Code session. It is designed to carry
high-bandwidth payloads — audio, screenshots, video — efficiently, while keeping routing
metadata simple and debuggable.

If you just want to send data, use the [client library](#client-library) and skip the
wire details. The rest of this page is for people implementing a client in another
language, or reasoning about the protocol's guarantees.

## Where it fits

The `aiui-claude-channel mcp` process runs a small loopback web backend (see the package
[Overview](./)). It exposes three surfaces:

| Surface | Direction | Shape | Use |
| --- | --- | --- | --- |
| `GET /health` | — | JSON | liveness / registry probe |
| `POST /prompt` | in | JSON text | one-shot plain-text prompt |
| `/ws` | in | **binary frames** | streaming, multi-thread, media-capable |

`POST /prompt` is the trivial path — one prompt, one HTTP request. `/ws` is the rich path
this page documents: many concurrent streams of typed messages, with the payload bytes
carried raw.

The server binds `127.0.0.1` on an OS-assigned port and there is **no authentication** —
it assumes a cooperative, same-host client. It also assumes clients are non-malicious:
thread ids are client-generated (typically UUIDs) and the server does not guard one
client's threads against another's.

## Design in one breath

Three decisions define the protocol:

1. **Binary WebSocket frames, not JSON text.** WebSocket has a native binary frame type;
   using it means audio/video/screenshot bytes travel as-is, with none of the ~33 % size
   inflation and CPU cost that base64-inside-JSON would impose.
2. **Length-prefix only the header, not the message.** WebSocket already delimits whole
   messages and hands each one over with a known length — so there is no need to frame
   messages ourselves. We length-prefix just the small metadata header; the payload is
   simply "the rest of the frame."
3. **The payload is opaque; a per-format codec owns it.** The transport never looks inside
   the payload. Each stream format supplies a codec that turns a user payload into bytes
   and back (JSON for text formats, identity for raw media). That keeps the envelope tiny
   and uniform while letting formats be anything from `{ "text": "..." }` to an Opus frame.

Because the envelope is 2–3 fields wrapping opaque bytes, a schema/IDL system (Protocol
Buffers, etc.) would add ceremony without buying anything; MessagePack was the closest
alternative but adds a dependency on every client platform for a format this simple. The
length-prefixed-JSON-header approach re-implements in ~20 lines in any language.

## Frame format

Every **client → server** message is one WebSocket **binary** frame:

```
┌────────┬───────────────────────┬────────────────┐
│ u32 BE │ header (UTF-8 JSON)    │ payload bytes  │
│ hdrLen │ the envelope          │ raw / opaque   │
└────────┴───────────────────────┴────────────────┘
  4 bytes   hdrLen bytes            to end of frame
```

- **`hdrLen`** — an unsigned 32-bit **big-endian** (network byte order) integer: the byte
  length of the header that follows.
- **header** — `hdrLen` bytes of UTF-8 JSON, the [envelope](#the-envelope).
- **payload** — everything after the header to the end of the frame. Its length is
  implied by the WebSocket frame length (`frameLen − 4 − hdrLen`); there is no separate
  payload size field. These bytes are produced by the active format's codec and are never
  base64'd. Decoding is zero-copy — the payload is handed to the processor as a view into
  the received frame, not a copy.

**Server → client** replies go the other way and are small JSON **text** frames (see
[Responses](#responses)). The binary framing optimizes the high-bandwidth direction, which
is client → server; replies are tiny acknowledgements, so they stay human-readable text.

### The envelope

The header decodes to:

```ts
interface Envelope {
  v: number;                     // protocol version — currently 1
  kind: "hello" | "data";        // what this frame is
  format?: string;               // on hello: the stream format to speak
  meta?: HelloMeta;              // on hello: optional client context (see below)
  threadId?: string;             // on data: which thread this frame belongs to
  fin?: boolean;                 // on data: true if this is the thread's last frame
}
```

The current `PROTOCOL_VERSION` is `1`; it is bumped only for a change to the framing or
envelope shape that is not backward-compatible.

## Connection lifecycle

### 1. Hello

The **first** frame must be a hello declaring the stream format the connection will speak,
with an empty payload:

```json
{ "v": 1, "kind": "hello", "format": "text-concat" }
```

The server looks the format up in its registry. On success it replies `{ "ok": true }`.
If the format is unknown, or the first frame is not a well-formed hello, the reply is
**fatal** and the socket is closed:

```json
{ "ok": false, "fatal": true, "error": "unknown format \"…\" (known formats: text-concat)" }
```

A connection speaks exactly one format for its lifetime.

A hello may additionally carry **client context** — where the connection comes from:

```ts
interface HelloMeta {
  tab?: {                        // the browser tab the client page lives in
    url?: string;                // live location.href at send time
    title?: string;              // live document.title at send time
    chromeTabId?: number;        // chrome.tabs.Tab.id      ─┐ stamped by the aiui
    windowId?: number;           // chrome.tabs.Tab.windowId ├ DevTools extension
    tabIndex?: number;           // index in its window      │ (correlation hints,
    targetId?: string;           // CDP Target.TargetID     ─┘  never MCP pageIds)
  };
  source?: {
    root?: string;               // the app's source root (its Vite root)
  };
}
```

`meta` is optional end to end — a bare client omits it and everything still works. The
connection hands it to every thread's processor (`ThreadContext.hello`); tracing records
it as an `info` stage; the `text-concat` processor uses it to prefix the lowered prompt
with the tab and source context. How the values are gathered browser-side is the dev
overlay's *Client context* doc; how an agent uses them to reach the tab is the
`session-browser` skill.

### 2. Data

After hello, every frame is a `data` frame naming a thread:

```json
{ "v": 1, "kind": "data", "threadId": "5f0c…", "fin": false }
```

…followed by a payload the format's codec understands. The first frame seen for a given
`threadId` **creates** that thread's processor; every subsequent frame for the same id is
decoded and delivered to that same processor, in arrival order. Thread ids are opaque to
the server — use a UUID.

### 3. Fin & close

A frame with `"fin": true` marks the **last** message of its thread. `fin` lives in the
envelope, not the payload, so end-of-stream is signalled the same way whether the payload
is JSON or raw audio. The final data chunk and `fin` may ride the same frame.

The framework surfaces `fin` to the processor, but the **processor** decides when to
actually close the thread (via its `close()` handle) — typically on `fin`. The reply to
the frame that closed the thread carries `"closed": true`. After that, any further frame
naming that `threadId` is rejected as an error (non-fatal — the connection stays usable):

```json
{ "ok": false, "threadId": "5f0c…", "error": "thread \"5f0c…\" is closed" }
```

## Responses

Every frame gets exactly one reply, a JSON text frame:

```ts
interface ChannelResponse {
  ok: boolean;
  threadId?: string;   // echoed when the frame named one
  closed?: boolean;    // true when this frame closed the thread
  error?: string;      // present when ok is false
  fatal?: boolean;     // true when the connection is unusable and is being dropped
}
```

Replies arrive **in the order the frames were sent**, one per frame — so a client can pair
each reply with its request by FIFO order (which is what the client library does). The
per-frame ack also serves as flow-control feedback.

### Error taxonomy

| Condition | `ok` | `fatal` | Socket |
| --- | --- | --- | --- |
| Non-binary frame received | `false` | `true` | closed |
| Malformed first frame / bad hello | `false` | `true` | closed |
| Unknown format at hello | `false` | `true` | closed |
| `data` frame missing a usable `threadId` | `false` | — | stays open |
| Frame for an already-closed thread | `false` | — | stays open |
| Payload fails to decode (codec threw) | `false` | — | stays open |
| Processor threw handling the frame | `false` | — | stays open |

**Fatal** errors mean the connection is unrecoverable and the server closes the socket
after the reply. Non-fatal errors reject a single frame and leave the connection (and its
other threads) working.

## Formats and codecs

A **format** is the pairing of a **codec** (how its payload bytes encode/decode) with a
**processor** (what to do with the decoded payloads):

```ts
interface ChannelFormat {
  codec: PayloadCodec;                 // bytes  <-> payload value
  createProcessor: (ctx) => StreamProcessor;   // one per thread
}
```

Two codecs ship and are reused across formats:

- **`jsonCodec`** — marshals the payload to/from UTF-8 JSON. An empty payload decodes to
  `undefined` (so a bare `fin` frame can carry no bytes); `undefined` encodes to `null`.
- **`rawCodec`** — the identity codec: the payload **is** its bytes. This is the path that
  keeps audio/video/screenshot frames raw end to end.

A processor sees only decoded values, never bytes:

```ts
interface StreamProcessor {
  onMessage(payload: unknown, meta: { fin: boolean }): void | Promise<void>;
}
```

`onMessage` calls are serialized per connection: an async processor never sees the next
frame until it has finished the current one. Throwing from `onMessage` rejects that frame
(non-fatal) without closing the thread.

### Built-in format: `text-concat`

`text-concat` pairs `jsonCodec` with a processor that accumulates text. Each data frame
carries an optional `{ "text": string }` chunk; chunks are concatenated verbatim (no
separator) until a `fin` frame, which sends the accumulated text into the session as a
single prompt and closes the thread. A thread finished with nothing accumulated closes
without sending anything.

### Custom formats

Hand `startWebServer` a registry keyed by format name:

```ts
import { startWebServer, defaultFormats, rawCodec } from "@habemus-papadum/aiui-claude-channel";

await startWebServer({
  onPrompt,
  formats: new Map([
    ...defaultFormats(),
    ["screenshots", {
      codec: rawCodec,                       // payload is raw PNG bytes
      createProcessor: (ctx) => ({
        onMessage(bytes, { fin }) {
          // …handle each Uint8Array chunk; on fin, act and ctx.close()
        },
      }),
    }],
  ]),
});
```

## Concurrency model

- **Many connections.** Each WebSocket connection gets its own protocol state machine; its
  threads die with it, and connections never share state.
- **Many threads per connection.** A connection may interleave any number of threads. The
  same `threadId` on two different connections denotes two independent threads — the server
  keys threads within a connection, not globally.
- **Strict per-connection ordering.** Frames on one connection are processed one at a time,
  in order, across all its threads.

## Client library

`connectChannelClient` hides the framing and codecs entirely:

```ts
import { connectChannelClient, rawCodec } from "@habemus-papadum/aiui-claude-channel";

// Text: the default jsonCodec suits text-concat.
const client = await connectChannelClient({ url: "ws://127.0.0.1:PORT/ws", format: "text-concat" });
const t = client.openThread();            // client-generated UUID thread id
await t.send({ text: "Summarize " });
await t.finish({ text: "this repo." });   // fin → server flushes the prompt
await client.close();

// Media: pass rawCodec and stream Uint8Array frames straight through (no base64).
const media = await connectChannelClient({ url, format: "screenshots", codec: rawCodec });
const s = media.openThread();
await s.send(pngChunk1);
await s.finish(pngChunk2);
```

`connectChannelClient` completes the hello handshake before resolving, and rejects if the
connection fails or the server rejects the format. Each `send`/`finish` resolves with the
server's `ChannelResponse` for that frame. The codec passed to the client must match what
the server's format decodes with.

## Implementing a client in another language

The whole format is a length-prefixed header plus raw bytes over a binary WebSocket frame.
In the browser, with no dependencies:

```js
const enc = new TextEncoder();

function encodeFrame(envelope, payload = new Uint8Array(0)) {
  const header = enc.encode(JSON.stringify(envelope));
  const frame = new Uint8Array(4 + header.length + payload.length);
  new DataView(frame.buffer).setUint32(0, header.length, false); // big-endian
  frame.set(header, 4);
  frame.set(payload, 4 + header.length);
  return frame;
}

const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";
ws.onopen = () => ws.send(encodeFrame({ v: 1, kind: "hello", format: "text-concat" }));
ws.onmessage = (e) => console.log("ack", JSON.parse(e.data)); // acks are JSON text
// then, per thread:
const threadId = crypto.randomUUID();
ws.send(encodeFrame({ v: 1, kind: "data", threadId, fin: false }, enc.encode("hi")));
ws.send(encodeFrame({ v: 1, kind: "data", threadId, fin: true }));
```

Decoding is the mirror image: read the big-endian `u32`, slice `[4, 4+hdrLen)` as the JSON
header, and take the remainder as the payload.

### Large payloads

Each frame is one WebSocket message; the `ws`-based server enforces a default maximum
message size. For media larger than that (long audio, big frames), split the payload across
several `data` frames on one thread and reassemble in the processor, marking the last frame
`fin`. Prefer streaming smaller chunks over buffering one enormous frame.

## Source & API

The protocol is implemented in a few small, transport-decoupled modules:

- **`frame.ts`** — `encodeFrame` / `decodeFrame`, the `Envelope`, `PROTOCOL_VERSION`.
- **`codec.ts`** — `PayloadCodec`, `jsonCodec`, `rawCodec`.
- **`channel.ts`** — `createChannelConnection`, the per-connection state machine.
- **`processors.ts`** — `defaultFormats`, `textConcatFormat`.
- **`client.ts`** — `connectChannelClient`.
- **`web.ts`** — the HTTP + WebSocket backend that wires it to a live session.

See the [API Reference](./api/) for the exported types and functions.
