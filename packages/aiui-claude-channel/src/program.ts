import { Command } from "commander";
import { runConfig } from "./commands/config";
import { runMcp } from "./commands/mcp";

// Injected at build time by Vite's `define` (see vite.config.ts). The `typeof`
// guard is a no-op in the built CLI (where the define replaces it with a string
// literal) but keeps this working anywhere the define isn't applied.
declare const __AIUI_CHANNEL_VERSION__: string;
const VERSION =
  typeof __AIUI_CHANNEL_VERSION__ === "string" ? __AIUI_CHANNEL_VERSION__ : "0.0.0+dev";

/**
 * Build the `aiui-claude-channel` command tree.
 *
 * Kept separate from the executable entrypoint (cli.ts) so tests can construct
 * and inspect the program without actually running it.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("aiui-claude-channel")
    .description("Claude Code channel — an MCP server that pushes aiui events into a session")
    .version(VERSION);

  program.command("mcp").description("launch the MCP channel server over stdio").action(runMcp);

  program.command("config").description("print the channel config as JSON").action(runConfig);

  return program;
}
