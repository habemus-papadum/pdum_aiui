# @habemus-papadum/aiui-claude-channel

MCP server providing a custom Claude channel, plus a CLI to launch it and print config.

## Install

```sh
npm install @habemus-papadum/aiui-claude-channel
```

## CLI

```sh
# Launch the MCP channel server over stdio (this is what Claude Code spawns).
aiui-claude-channel mcp

# Pick a running server and push a prompt into its session (end-to-end check).
aiui-claude-channel quick --message "What is the capital of England?"

# Same, but exercise the /ws websocket path instead of POST /prompt.
aiui-claude-channel quick --ws --message "What is the capital of England?"

# Print the channel config as JSON.
aiui-claude-channel config
```

## Usage

```ts
import { createChannelServer, CHANNEL_CONFIG } from "@habemus-papadum/aiui-claude-channel";

const server = createChannelServer("1.0.0"); // an unconnected MCP Server
```

## The websocket protocol

The `mcp` command's web backend serves a `/ws` websocket speaking a compact
**binary** protocol (no auth; loopback only), designed to carry audio,
screenshots, and video without base64 overhead. Most consumers should use the
[client library](#client-library) rather than encode frames by hand.

### Wire format

Client → server frames are WebSocket **binary** frames; each is one channel
message laid out as a length-prefixed header followed by the raw payload:

```
┌────────┬───────────────────────┬────────────────┐
│ u32 BE │ header (UTF-8 JSON)    │ payload bytes  │
│ hdrLen │ the envelope          │ raw / opaque   │
└────────┴───────────────────────┴────────────────┘
```

WebSocket already delimits whole messages, so only the header is
length-prefixed — the payload is the rest of the frame, and is never base64'd
or copied on decode. Server → client replies are small JSON **text** frames
(`{ "ok": true, ... }` / `{ "ok": false, "error": ... }`), since the
high-bandwidth direction is client → server.

The header envelope is `{ v, kind, format?, threadId?, fin? }`:

1. **Hello.** The first frame declares the stream format:
   `{"v":1,"kind":"hello","format":"text-concat"}` with an empty payload. The
   format is looked up in the server's registry; an unknown format (or a
   malformed hello) is fatal — the reply carries `"fatal": true` and the socket
   is closed.
2. **Data.** After hello, frames are `{"v":1,"kind":"data","threadId":"<uuid>","fin":false}`
   plus a payload. The first frame for a new thread id creates that thread's
   processor; each frame's payload is decoded by the format's codec and fed to
   the processor in arrival order. A connection may interleave any number of
   threads, and the server any number of connections — the same thread id on
   two connections is two independent threads.
3. **Close.** A frame with `"fin": true` marks the thread's last message. The
   processor decides when to actually close (e.g. on `fin`); the reply carries
   `"closed": true`, and any later frame naming that thread id is an error.

### Formats and codecs

A **format** pairs a **codec** (how its payload bytes decode) with a
**processor** (what to do with the decoded payloads). Two codecs ship and are
reused across formats:

- `jsonCodec` — marshals the payload to/from JSON (for text-shaped formats);
- `rawCodec` — identity, the payload *is* the bytes (the efficient path for
  already-encoded audio/video/screenshots).

Built-in format **`text-concat`** (jsonCodec): each data frame carries an
optional `{ "text": string }` chunk, concatenated verbatim until a `fin` frame,
which sends the accumulated text into the session as one prompt and closes the
thread.

Custom formats: hand `startWebServer` a registry —
`startWebServer({ onPrompt, formats: new Map([...defaultFormats(), ["my-format", { codec, createProcessor }]]) })`.
A `createProcessor` receives the thread's context (`threadId`, `sendPrompt`,
`close`) and returns `{ onMessage(payload, { fin }) }`.

### Other websocket endpoints

The same web backend serves two JSON (text-frame) endpoints alongside `/ws`:

- **`/tools`** — the page-tools bridge. A page's `agentToolkit` namespaces register here so the
  session can list/call them as MCP tools (`PageToolDirectory`).
- **`/session`** — the **session bus** (`SessionHub`): several browser views of one session share
  arming + the prompt preview (last-writer-wins slots) and fan code contributions to each other
  (transient publishes). A late-joining view gets a snapshot so it opens already in sync. The hub
  relays and caches opaque JSON — it interprets nothing. `/health` advertises a `session` summary.
  See the repo's **Multi-View Sessions** guide.

Both are routed by pathname in a single `upgrade` handler; the binary `/ws` protocol above is
unaffected.

## Client library

`connectChannelClient` hides the framing and codecs — connect declaring a
format, open threads, and send payloads:

```ts
import { connectChannelClient, rawCodec } from "@habemus-papadum/aiui-claude-channel";

// Text: the default jsonCodec suits text-concat.
const client = await connectChannelClient({ url: "ws://127.0.0.1:PORT/ws", format: "text-concat" });
const t = client.openThread();              // client-generated UUID thread id
await t.send({ text: "Summarize " });
await t.finish({ text: "this repo." });     // fin → server flushes the prompt
await client.close();

// Media: pass rawCodec and send Uint8Array frames straight through (no base64).
const media = await connectChannelClient({ url, format: "screenshots", codec: rawCodec });
await media.openThread().finish(pngBytes);
```
