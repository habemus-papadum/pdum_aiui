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
| `/tools` | both | JSON text | page-declared tools the agent can call (see [The `/tools` endpoint](#the-tools-endpoint)) |

`POST /prompt` is the trivial path — one prompt, one HTTP request. `/ws` is the rich path
this page documents first: many concurrent streams of typed messages, with the payload bytes
carried raw. `/tools` is a separate, request/response JSON protocol — a browser page registers the
tools it exposes and answers the calls the agent routes back to it; it is documented in its own
section below.

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
  chunk?: ChunkDescriptor;       // on data: intent-v1 payload tag (see that format)
}
```

The current `PROTOCOL_VERSION` is `1`; it is bumped only for a change to the framing or
envelope shape that is not backward-compatible. `chunk` is additive: only `intent-v1`
frames set it, and its absence is exactly the legacy behavior every other format relies on.

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
  intent?: unknown;              // the client's IntentPipelineConfig view (intent-v1)
}
```

`meta` is optional end to end — a bare client omits it and everything still works. The
connection hands it to every thread's processor (`ThreadContext.hello`); tracing records
it as an `info` stage; the `text-concat` processor uses it to prefix the lowered prompt
with the tab and source context. `intent` is typed loosely on purpose — the envelope
carries no dependency on the intent-pipeline package; the `intent-v1` processor validates
the fields it reads (`transcriber`, `model`, `corrector`, `correctionModel`,
`correctionPolicy`, `passes`). How the values are gathered browser-side is the dev
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

A processor may also push **out-of-band** server → client messages that are *not* acks —
today only the [`intent-v1`](#built-in-format-intent-v1) format does, sending `lowered`
messages. These always carry a `kind` field (acks never do), so a client distinguishes
them by shape and keeps matching acks to frames by FIFO among the messages that have **no**
`kind`. An out-of-band message may arrive interleaved with acks (typically just before the
ack of the frame that produced it); order across the two streams is not guaranteed.

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

### Built-in format: `intent-v1`

`intent-v1` is the multimodal intent tool's format. Where `text-concat` accumulates a
string, `intent-v1` accumulates the intent tool's **event log** plus binary attachments
(audio segments, screenshot PNGs), and on `fin` **lowers** the whole turn into one
Option-C prompt — a body with `{shot_N}` tokens and the image paths in `meta` (see
[`archive/channel-attachment-path-encoding.md`](../../../archive/channel-attachment-path-encoding.md)).
The lowering — transcription, the correction diff, the pass structure, `composeIntent`,
Option-C assembly — runs **in the channel**, keyed by the channel process's environment;
the pipeline core is shared with the browser modality
(`@habemus-papadum/aiui-dev-overlay/intent-pipeline`), so one implementation and one set of
captured fixtures cover both sides.

Its codec is `rawCodec` (the payload is opaque bytes). What a payload *means* depends on the
frame's **chunk tag** in the envelope — which the codec, seeing only bytes, cannot know — so
the meaning rides `envelope.chunk`:

```ts
type ChunkDescriptor =
  | { kind: "events" }                                    // JSON { events: IntentEvent[] }
  | { kind: "context" }                                   // JSON { selection?: … }
  | { kind: "attachment"; id: string; mime: string };     // raw bytes (shot_N / seg_N)
```

**Client → server** `data` frames (all on one thread, `fin` on the last):

| chunk | payload | meaning |
| --- | --- | --- |
| `{ kind: "events" }` | UTF-8 JSON `{ events }` | an append-only batch of the interaction log; batches arrive in order and are concatenated |
| `{ kind: "attachment", id: "shot_N", mime }` | raw PNG bytes | a region/viewport screenshot |
| `{ kind: "attachment", id: "seg_N", mime }` | raw audio bytes | the audio for talk segment N (e.g. `audio/webm;codecs=opus`, `audio/wav`) |
| `{ kind: "context" }` | UTF-8 JSON `{ selection? }` | the on-screen selection, sent at most once, just before `fin` |

Attachment `id`s are identifier-shaped (`shot_1`, `seg_2`) so a `shot_N` doubles as its
Option-C meta key. `mime` on an audio segment names the container — the server uses it to
name the upload file, which is how OpenAI's STT sniffs the codec.

**Server → client** — besides the per-frame ack, the processor pushes `lowered` messages
(distinguished by `kind`) carrying events it produced for the client to merge into its own
stream:

```jsonc
{ "kind": "lowered", "threadId": "…", "events": [ /* IntentEvent[] */ ] }
```

Two producers, both gated on the hello's `intent` config:

- **Transcription.** When a `seg_N` attachment arrives and `intent.transcriber === "openai"`,
  the segment is transcribed server-side (`OPENAI_API_KEY`, model from `intent.model`) and a
  `{ type: "transcript-final", segment: N, text, latencyMs, model }` event is pushed. With
  `intent.transcriber === "mock"` the client's own `transcript-final` events (already in its
  `events` batches) are used and nothing is transcribed.
- **Correction diff.** A `correction` event that arrives **without** a `patch` while
  `intent.corrector === "openai"` is a *request*: the V4A diff runs server-side (temperature
  0, model `intent.correctionModel`; the document is the current transcript as
  segments-as-lines, via `composeIntent`) and the completed correction event (same
  `from`/`to`/`original`/`instruction`/`via`, plus `patch`/`model`/`latencyMs`) is pushed. A
  diff that fails or produces a patch that will not apply is pushed **without** a `patch`, so
  the client falls back to plain replacement — corrections never silently vanish. A correction
  that already carries a `patch` (e.g. a mock-transcriber turn) passes straight through.

**The `fin` lowering.** On the final frame the processor:

1. saves each attachment to the trace blob store (`.aiui-cache/traces/<id>/shot_N.png`,
   `seg_N.<ext>`) and wires each `shot_N`'s absolute path into the shot event;
2. runs the condition passes (silence-trim on audio, image-downscale on shots — gated by
   `intent.passes`; identity stubs today, the structure is what matters);
3. folds the merged event stream with `composeIntent` (applying corrections under
   `intent.correctionPolicy`) into the Option-C body + meta;
4. wraps the body in the same tab/source/selection context block `text-concat` uses and
   sends it as one prompt — the body's `{shot_N}` tokens in the notification `content`, the
   `shot_N` → absolute-path map in the notification `meta`.

A thread that ends in an explicit **cancel** (`thread-close` with `reason: "cancel"`), or
one that never `fin`s (the socket just closes), lowers to **no notification**. Every stage
(client context → merged events → composed intent → conditioned → lowered prompt) is
recorded on the thread's trace, so the `/debug` viewer shows the whole lowering with
hover-previewable attachment paths.

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

## The `/tools` endpoint

`/ws` pushes data *into* the session. `/tools` is the other direction of the loop: it lets a
browser page under development **expose tools to the agent**. A page (via the aiui dev overlay's
tools bridge) declares the tools it can honestly support — name, description, JSON Schema — and the
channel surfaces them to the Claude Code session as the MCP tools `page_tools_list` and
`page_tools_call`. When the agent calls one, the channel routes it back down this socket to the live
page function, and the result returns the same way.

Unlike `/ws`, this is a **request/response JSON protocol**, not a binary media stream: every message
is a single WebSocket **text** frame carrying one JSON object. The payloads are tiny (schemas,
argument objects, results), so the binary framing `/ws` uses would buy nothing here. Like `/ws`,
there is no authentication — it assumes a cooperative same-host client.

### Directory model

The channel keeps a **directory** of registrations. A registration is one namespace's full tool set
on one connection:

```ts
interface PageToolRegistration {
  clientId: string;        // server-assigned, per connection
  ns: string;              // page namespace ("morpho", "aztec", …), unique per connection
  url?: string;            // the page's location.href at registration
  tab?: TabInfo;           // browser tab identity (correlation hints — see /ws HelloMeta)
  source?: SourceInfo;     // the page's source root
  hash: string;            // page-computed content hash of the tool set (identity across reloads)
  tools: { name: string; description: string; inputSchema?: object }[];
  registeredAt: string;    // ISO timestamp of the latest registration
}
```

A connection may hold **several namespaces**; a page reload **replaces** a namespace's entry rather
than adding one (identity is `(clientId, ns)`); and a registration is dropped when its socket closes
(pages don't get to run code when they die). The whole directory lives only in the channel process's
memory.

### Messages

**client → server**

```jsonc
// declare the full tool set for one namespace (idempotent; replaces the ns entry)
{ "v": 1, "type": "register", "ns": "morpho", "url": "http://localhost:5173/",
  "tab": { "title": "morpho" }, "source": { "root": "/repo/app" }, "hash": "a1b2c3d4",
  "tools": [ { "name": "set-params", "description": "set the sim parameters",
              "inputSchema": { "type": "object", "properties": { /* … */ } } } ] }

// answer a call the server routed to this connection
{ "v": 1, "type": "result", "callId": "…", "ok": true,  "value": <any JSON> }
{ "v": 1, "type": "result", "callId": "…", "ok": false, "error": "human-readable message" }
```

**server → client**

```jsonc
// invoke one of this connection's tools
{ "v": 1, "type": "call", "callId": "…", "ns": "morpho", "name": "set-params", "args": { /* … */ } }

// acknowledge a register (optional for the client to use)
{ "v": 1, "type": "registered", "ns": "morpho", "hash": "a1b2c3d4" }
```

### Two design rules the client must honor

- **Registration is declarative, and forwarding is hashed.** The client always re-declares its
  *complete* current set for a namespace (on connect, on reload, on HMR graph-swap) and carries a
  content hash of the schema-relevant fields (name, description, inputSchema — never the function).
  The server logs a registration line **only when the hash changes**, so the constant churn of dev
  reloads with an unchanged tool set is invisible to the agent, and the MCP tool list never flickers.
- **Implementations resolve at call time.** The client holds no function references across reloads —
  when a `call` arrives it looks the implementing function up in the *current* registry by name.
  Then HMR replacing every closure changes nothing observable.

### Calls, ambiguity, and lifecycle

`page_tools_call` takes `{ name, args?, ns?, clientId? }`. The directory routes to the **one**
registration that matches (a tool with that `name`, narrowed by `ns`/`clientId` when given):

- **exactly one match** → the call is sent to that connection; the promise resolves on the matching
  `result` (default timeout 15 s).
- **several matches** → the call errors, listing the candidates (`clientId`, `ns`, `url`, `tab`) so
  the agent can retry with `ns` and/or `clientId`.
- **no page connected / no tool matches** → a clear error.
- **the page disconnects before answering** → any in-flight call for that connection rejects.

`GET /health` includes a cheap `pageTools` summary (`{ clients, namespaces, tools }`) and is
served with `Access-Control-Allow-Origin: *`: browsers log failed websocket handshakes as
unsuppressable console errors, so a well-behaved client (the dev overlay's tools bridge) probes
`/health` cross-origin first and only dials `/tools` when the payload advertises `pageTools`.
The CORS header shipped together with `/tools`, so its absence identifies a pre-`/tools` server.

### Not yet: per-tool MCP registration

This iteration exposes page tools through the two fixed MCP tools (`page_tools_list` /
`page_tools_call`); it does **not** register each page tool as its own dynamically-named MCP tool.
That is the natural follow-up.

## Source & API

The protocol is implemented in a few small, transport-decoupled modules:

- **`frame.ts`** — `encodeFrame` / `decodeFrame`, the `Envelope`, `ChunkDescriptor`, `PROTOCOL_VERSION`.
- **`codec.ts`** — `PayloadCodec`, `jsonCodec`, `rawCodec`.
- **`channel.ts`** — `createChannelConnection`, the per-connection state machine.
- **`processors.ts`** — `defaultFormats`, `textConcatFormat`.
- **`prompt-context.ts`** — `augmentTextPrompt`, the shared tab/source/selection preamble.
- **`intent-v1.ts`** — the `intent-v1` format: codec + lowering processor.
- **`transcribe.ts`** / **`correct.ts`** — the server-side transcription and correction-diff seams (mock + OpenAI REST).
- **`client.ts`** — `connectChannelClient`.
- **`page-tools.ts`** — `PageToolDirectory`, the `/tools` registry and call router.
- **`web.ts`** — the HTTP + WebSocket backend that wires both `/ws` and `/tools` to a live session.

See the [API Reference](./api/) for the exported types and functions.
