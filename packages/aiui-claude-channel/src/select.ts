/**
 * Interactive selection of a running channel server — the "which one?" widget
 * shared by CLI subcommands like `quick`.
 */
import { select } from "@inquirer/prompts";
import { agentsByPid, type ClaudeAgent, listClaudeAgents } from "./agents";
import type { RunningServer } from "./registry";

/**
 * Render a server as a selector row. Prefers the entry's own display name
 * (debug servers name themselves via `--name`), then the owning Claude
 * Code session's name (matched by `ppid`, how a user recognises which session
 * a channel belongs to), then the raw pid. Debug entries are always marked:
 * picking one means prompts print to that server's stdout, not a session.
 */
export function serverLabel(server: RunningServer, agents: Map<number, ClaudeAgent>): string {
  const agent = agents.get(server.ppid);
  const who = server.name ?? (agent ? agent.name : `pid ${server.ppid}`);
  const mark = server.debug === true ? "  ·  debug" : "";
  return `${who}  ·  ${server.cwd}  ·  port ${server.port}${mark}`;
}

/**
 * Prompt the user to pick one of the given running servers, labelling each with
 * its name (or Claude Code session), working directory, and port. With a single
 * *real* server there's nothing to choose, so it's returned directly — but a
 * lone **debug** server still prompts: connecting to a server that answers to
 * nobody must be a deliberate choice, never a silent default.
 *
 * @throws if `servers` is empty — callers should handle "none running" before
 * reaching the widget.
 */
export async function selectMcpServer(servers: RunningServer[]): Promise<RunningServer> {
  if (servers.length === 0) {
    throw new Error("no running aiui MCP servers to choose from");
  }
  if (servers.length === 1 && servers[0].debug !== true) {
    return servers[0];
  }
  const agents = agentsByPid(listClaudeAgents());
  return select({
    message: "Select a running aiui MCP server",
    choices: servers.map((server) => ({
      name: serverLabel(server, agents),
      value: server,
    })),
  });
}
