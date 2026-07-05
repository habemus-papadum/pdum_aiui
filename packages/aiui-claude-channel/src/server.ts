import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { PageToolDirectory } from "./page-tools";
import { registerChannelTools } from "./tools";

/** Optional wiring for {@link createChannelServer}. */
export interface ChannelServerOptions {
  /**
   * The page-tool registry to expose through the `page_tools_list` /
   * `page_tools_call` MCP tools. Omit it (as tests and the bare server do) and
   * those tools are simply not advertised — only `channel_info` is.
   */
  pageTools?: PageToolDirectory;
}

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
 * server), plus a `tools` capability for `channel_info` and — when a page-tool
 * directory is supplied — `page_tools_list`/`page_tools_call` (see
 * {@link registerChannelTools}). It is returned unconnected so callers (and
 * tests) can inspect it without wiring up a transport.
 */
export function createChannelServer(version: string, options: ChannelServerOptions = {}): Server {
  const server = new Server(
    { name: "aiui", version },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions: INSTRUCTIONS,
    },
  );
  registerChannelTools(server, options.pageTools);
  return server;
}
