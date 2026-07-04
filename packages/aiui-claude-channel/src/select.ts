/**
 * Interactive selection of a running channel server — the "which one?" widget
 * shared by CLI subcommands like `quick`.
 */
import { select } from "@inquirer/prompts";
import type { RunningServer } from "./registry";

/**
 * Prompt the user to pick one of the given running servers, rendering each as
 * its working directory with the pid/port for disambiguation. With a single
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
  return select({
    message: "Select a running aiui MCP server",
    choices: servers.map((server) => ({
      name: `${server.cwd}  ·  pid ${server.pid}, port ${server.port}`,
      value: server,
    })),
  });
}
