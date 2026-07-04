/**
 * Interactive selection of a running channel server — the "which one?" widget
 * shared by CLI subcommands like `quick`.
 */
import { select } from "@inquirer/prompts";
import { agentsByPid, type ClaudeAgent, listClaudeAgents } from "./agents";
import type { RunningServer } from "./registry";

/**
 * Render a server as a selector row. Prefers the owning Claude Code session's
 * name (matched by `ppid`) over a raw pid, since that's how a user recognises
 * which session a channel belongs to; falls back to the pid when the session
 * isn't known.
 */
export function serverLabel(server: RunningServer, agents: Map<number, ClaudeAgent>): string {
  const agent = agents.get(server.ppid);
  const who = agent ? agent.name : `pid ${server.ppid}`;
  return `${who}  ·  ${server.cwd}  ·  port ${server.port}`;
}

/**
 * Prompt the user to pick one of the given running servers, labelling each with
 * its Claude Code session name, working directory, and port. With a single
 * server there's nothing to choose, so it's returned directly.
 *
 * @throws if `servers` is empty — callers should handle "none running" before
 * reaching the widget.
 */
export async function selectMcpServer(servers: RunningServer[]): Promise<RunningServer> {
  if (servers.length === 0) {
    throw new Error("no running aiui MCP servers to choose from");
  }
  if (servers.length === 1) {
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
