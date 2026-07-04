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

# Print the channel config as JSON.
aiui-claude-channel config
```

## Usage

```ts
import { createChannelServer, CHANNEL_CONFIG } from "@habemus-papadum/aiui-claude-channel";

const server = createChannelServer("1.0.0"); // an unconnected MCP Server
```
