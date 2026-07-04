/**
 * The MCP tools the channel server exposes to its Claude Code session.
 *
 * There's one — `channel_info` — and it reports *this* server's own info: its
 * tag, pid, port, cwd, and the Claude Code session it's attached to. A server
 * describes itself, not its siblings. (Enumerating every running channel is a
 * separate concern — see {@link collectChannelInfo} / `listMcpServers`, the
 * library utilities the CLI uses.)
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type ClaudeAgent, enrichServers, listClaudeAgents, type SessionInfo } from "./agents";
import { type RegistryEntry, readEntry, registryFileFor } from "./registry";

const CHANNEL_INFO_TOOL = "channel_info";

/** A channel server plus the Claude Code session that owns it. */
export interface ChannelInfo {
  tag: string;
  pid: number;
  ppid: number;
  port: number;
  cwd: string;
  startedAt: string;
  session?: SessionInfo;
}

/**
 * Pair registry entries with the Claude sessions that own them (matched by
 * `ppid`), dropping the on-disk `file` path. Pure given its inputs, so it's
 * testable without a live registry or `claude`. Used to describe one channel
 * (the `channel_info` tool) or many (a "list all" utility).
 */
export function collectChannelInfo(entries: RegistryEntry[], agents: ClaudeAgent[]): ChannelInfo[] {
  return enrichServers(entries, agents).map((s) => ({
    tag: s.tag,
    pid: s.pid,
    ppid: s.ppid,
    port: s.port,
    cwd: s.cwd,
    startedAt: s.startedAt,
    ...(s.session ? { session: s.session } : {}),
  }));
}

/** What {@link selfChannelInfo} returns before the server has registered. */
export interface UnregisteredInfo {
  registered: false;
  pid: number;
}

/**
 * This process's own channel info: its registry entry enriched with the Claude
 * session that owns it. Shared by the `channel_info` MCP tool and the debug
 * API's `/debug/api/info`.
 */
export function selfChannelInfo(): ChannelInfo | UnregisteredInfo {
  const self = readEntry(registryFileFor(process.pid));
  if (!self) {
    return { registered: false, pid: process.pid };
  }
  return (
    collectChannelInfo([self], listClaudeAgents())[0] ?? { registered: false, pid: process.pid }
  );
}

/**
 * Register the channel server's tools. Requires the server to have been created
 * with the `tools` capability (see {@link createChannelServer}).
 */
export function registerChannelTools(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: CHANNEL_INFO_TOOL,
        description:
          "Return this aiui channel's own info: its tag, pid, ppid, port, cwd, and the " +
          "Claude Code session it's attached to (name, sessionId, status). Returns a JSON object.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    if (request.params.name !== CHANNEL_INFO_TOOL) {
      throw new Error(`unknown tool: ${request.params.name}`);
    }
    // Report our own registry entry (the file this process wrote for itself).
    return { content: [{ type: "text", text: JSON.stringify(selfChannelInfo(), null, 2) }] };
  });
}
