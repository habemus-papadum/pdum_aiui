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

The `mcp` command's web backend serves a `/ws` websocket speaking a small
JSON protocol (no auth; loopback only). Every message gets a JSON reply
(`{ "ok": true, ... }` or `{ "ok": false, "error": ... }`).

1. **Hello.** The first message declares the stream format the connection will
   speak: `{"type": "hello", "format": "text-concat"}`. The format is looked up
   in the server's processor registry; an unknown format (or malformed hello)
   is fatal — the reply carries `"fatal": true` and the socket is closed.
2. **Thread messages.** Everything after hello is
   `{"threadId": "<client-generated id>", "payload": ...}`. The first message
   for a new thread id creates a stream processor for it (from the format's
   factory); each payload is fed to that thread's processor, in arrival order.
   A connection may interleave any number of threads, and the server any
   number of connections — the same thread id on two connections is two
   independent threads.
3. **Close.** The processor decides when its thread is done (e.g. the client
   said so) and closes it; the reply to the closing message carries
   `"closed": true`. Any later message naming that thread id is an error.

### Built-in format: `text-concat`

Payloads are `{ "text": string }` and/or `{ "done": true }`. Text chunks are
concatenated verbatim; `done` sends the accumulated text into the Claude Code
session as a single prompt and closes the thread.

```jsonc
> {"type": "hello", "format": "text-concat"}
< {"ok": true}
> {"threadId": "5f0c…", "payload": {"text": "Summarize "}}
< {"ok": true, "threadId": "5f0c…"}
> {"threadId": "5f0c…", "payload": {"text": "this repo.", "done": true}}
< {"ok": true, "threadId": "5f0c…", "closed": true}
```

Custom formats: build a registry and hand it to `startWebServer` —
`startWebServer({ onPrompt, processors: new Map([...defaultProcessors(), ["my-format", myFactory]]) })`.
A factory receives the thread's context (`threadId`, `sendPrompt`, `close`) and
returns `{ onMessage(payload) }`.
