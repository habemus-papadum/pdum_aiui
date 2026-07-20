/**
 * Interactive selection of a running channel server — the "which one?" widget
 * shared by CLI subcommands like `quick`. Servers arrive ENRICHED (the listing
 * already joined live session names), so labelling is just `resolvedName`.
 */
import { select } from "@inquirer/prompts";
import type { RunningServer } from "./registry";

/**
 * Render a server as a selector row: its resolved name (assigned name → live
 * Claude session name → host → pid), working directory, and port. Debug
 * entries are always marked: picking one means prompts print to that server's
 * stdout, not a session.
 */
export function serverLabel(server: RunningServer): string {
  const mark = server.kind === "debug" ? "  ·  debug" : "";
  return `${server.resolvedName}  ·  ${server.cwd}  ·  port ${server.port}${mark}`;
}

/**
 * Prompt the user to pick one of the given running servers. With a single
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
  if (servers.length === 1 && servers[0].kind !== "debug") {
    return servers[0];
  }
  return select({
    message: "Select a running aiui MCP server",
    choices: servers.map((server) => ({
      name: serverLabel(server),
      value: server,
    })),
  });
}
