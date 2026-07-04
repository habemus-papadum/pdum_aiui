import { Server } from "@modelcontextprotocol/sdk/server/index.js";

const INSTRUCTIONS = [
  "This is the aiui channel, a one-way event feed into your session.",
  'Events arrive as `<channel source="aiui" ...>` blocks: read them and act on',
  "them as context. This channel is one-way — there is nothing to reply to and",
  "no tool to call back into it.",
].join(" ");

/**
 * Construct the aiui Claude channel MCP `Server`.
 *
 * The server declares the experimental `claude/channel` capability, which is
 * what marks it as a Claude Code channel (rather than a plain tool/resource
 * server). It is returned unconnected so callers (and tests) can inspect it
 * without wiring up a transport.
 */
export function createChannelServer(version: string): Server {
  return new Server(
    { name: "aiui", version },
    {
      capabilities: { experimental: { "claude/channel": {} } },
      instructions: INSTRUCTIONS,
    },
  );
}
