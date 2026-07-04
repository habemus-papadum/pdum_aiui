import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerServer } from "../registry";
import { createChannelServer } from "../server";
import { startWebServer } from "../web";

export interface McpOptions {
  /**
   * Tag identifying this channel session. Defaults to a fresh UUID; pass one
   * (e.g. from a test harness) to make the server addressable by a known value.
   */
  tag?: string;
}

// Injected at build time by Vite's `define` (see vite.config.ts). The `typeof`
// guard is a no-op in the built CLI (where the define replaces it with a string
// literal) but keeps this working anywhere the define isn't applied.
declare const __AIUI_CHANNEL_VERSION__: string;
const VERSION =
  typeof __AIUI_CHANNEL_VERSION__ === "string" ? __AIUI_CHANNEL_VERSION__ : "0.0.0+dev";

/**
 * Launch the aiui channel MCP server over stdio.
 *
 * This is the process Claude Code spawns as a subprocess. On startup it:
 *  1. connects the stdio transport (completing the session handshake),
 *  2. starts a loopback web backend (POST /prompt, GET /health, ws /ws) that
 *     forwards text into the session over the channel, and
 *  3. advertises itself in the shared cache registry (tag, pid, parent pid,
 *     port, cwd) so tools like `quick` can find it.
 *
 * It then stays alive (the stdio transport keeps reading stdin). On the way out
 * — a signal, Claude Code disconnecting, or plain process exit — it removes its
 * registry file as reliably as it can, so stale entries are the exception (and
 * {@link listMcpServers} prunes those it misses).
 */
export async function runMcp(options: McpOptions = {}): Promise<void> {
  const tag = options.tag ?? randomUUID();
  const mcp = createChannelServer(VERSION);

  // Push text into the Claude Code session over the one-way channel.
  const pushToSession = (text: string, kind = "prompt"): Promise<void> =>
    mcp.notification({
      method: "notifications/claude/channel",
      params: { content: text, meta: { kind } },
    });

  // Connect stdio first: the handshake must complete before we open the backend
  // or advertise ourselves, so nothing can push a prompt before the channel is
  // live.
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  const web = await startWebServer({ onPrompt: (text) => pushToSession(text) });
  const registration = registerServer(web.port, tag);

  // Reliable cleanup. `remove()` is race-safe and idempotent, so calling it from
  // several exit paths is fine. The synchronous `exit` handler is the last-resort
  // backstop — it can't await, so it only unlinks the registry file.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    registration.remove();
    await web.close().catch(() => {});
    await mcp.close().catch(() => {});
  };

  process.on("exit", () => {
    registration.remove();
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }
  // When Claude Code exits, the stdio transport closes; treat that as shutdown.
  mcp.onclose = () => {
    void shutdown().finally(() => process.exit(0));
  };

  // Progress goes to stderr — stdout is the MCP protocol stream.
  process.stderr.write(
    `[aiui-channel] up — tag=${tag} pid=${process.pid} ppid=${process.ppid} port=${web.port} cwd=${process.cwd()}\n`,
  );

  await pushToSession("aiui channel connected", "startup");
}
