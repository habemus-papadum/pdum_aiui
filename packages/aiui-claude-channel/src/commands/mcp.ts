import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChannelServer } from "../server";

// Injected at build time by Vite's `define` (see vite.config.ts). The `typeof`
// guard is a no-op in the built CLI (where the define replaces it with a string
// literal) but keeps this working anywhere the define isn't applied.
declare const __AIUI_CHANNEL_VERSION__: string;
const VERSION =
  typeof __AIUI_CHANNEL_VERSION__ === "string" ? __AIUI_CHANNEL_VERSION__ : "0.0.0+dev";

/**
 * Launch the aiui channel MCP server over stdio.
 *
 * This is the process Claude Code spawns as a subprocess. Once the stdio
 * transport is connected the process stays alive (the transport keeps reading
 * stdin), so this resolves only after the initial handshake — the event loop
 * keeps running afterwards.
 */
export async function runMcp(): Promise<void> {
  const mcp = createChannelServer(VERSION);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // Emit a single startup event so a connected session sees the channel come up.
  // TODO: real event sources (an HTTP listener, a platform poller, etc.) are
  // TBD — this is a scaffold that only announces itself for now.
  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content: "aiui channel connected", meta: { kind: "startup" } },
  });
}
