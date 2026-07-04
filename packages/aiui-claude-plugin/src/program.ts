import { Command } from "commander";
import { runPath } from "./commands/path";

// Injected at build time by Vite's `define` (see vite.config.ts). The `typeof`
// guard is a no-op in the built CLI (where the define replaces it with a string
// literal) but keeps this working anywhere the define isn't applied.
declare const __AIUI_PLUGIN_VERSION__: string;
const VERSION = typeof __AIUI_PLUGIN_VERSION__ === "string" ? __AIUI_PLUGIN_VERSION__ : "0.0.0+dev";

/**
 * Build the `aiui-claude-plugin` command tree.
 *
 * Kept separate from the executable entrypoint (cli.ts) so tests can construct
 * and inspect the program without actually running it.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("aiui-claude-plugin")
    .description("the aiui Claude Code plugin — locates its bundled plugin directory")
    .version(VERSION);

  program
    .command("path")
    .description("print the absolute path to the bundled plugin directory")
    .action(runPath);

  return program;
}
