import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { PageToolDirectory } from "./page-tools";
import { registerChannelTools } from "./tools";
import type { ChannelReload } from "./web";

/** Optional wiring for {@link createChannelServer}. */
export interface ChannelServerOptions {
  /**
   * The page-tool registry to expose through the `page_tools_list` /
   * `page_tools_call` MCP tools. Omit it (as tests and the bare server do) and
   * those tools are simply not advertised — only `channel_info` is.
   */
  pageTools?: PageToolDirectory;
  /**
   * Reload handle to expose through the `channel_reload` MCP tool. The web
   * server is created after this one, so callers pass a late-bound thunk that
   * dereferences it (see commands/mcp.ts). Omit it and `channel_reload` is not
   * advertised.
   */
  reload?: ChannelReload;
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
 * server), plus a `tools` capability for `channel_info` and — when supplied —
 * `page_tools_list`/`page_tools_call` (a page-tool directory) and `channel_reload`
 * (a reload handle) (see {@link registerChannelTools}). `tools.listChanged` is
 * declared so the channel may send `notifications/tools/list_changed` when the
 * page-tool directory changes; the advertised MCP tool list itself stays the
 * static meta-tools — the notification's value is the refresh cycle it triggers
 * (measured safe cross- and mid-turn: archive/extension-spikes/RESULTS.md M3).
 * It is returned unconnected so callers (and tests) can inspect it without
 * wiring up a transport.
 */
export function createChannelServer(version: string, options: ChannelServerOptions = {}): Server {
  const server = new Server(
    { name: "aiui", version },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: { listChanged: true } },
      instructions: INSTRUCTIONS,
    },
  );
  registerChannelTools(server, {
    ...(options.pageTools ? { pageTools: options.pageTools } : {}),
    ...(options.reload ? { reload: options.reload } : {}),
  });
  return server;
}
