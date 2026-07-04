import { Command } from "commander";
import { runClaude } from "./commands/claude";
import { runVite } from "./commands/vite";

// Injected at build time by Vite's `define` (see vite.config.ts). The `typeof`
// guard is a no-op in the built CLI (where the define replaces it with a string
// literal) but keeps this working anywhere the define isn't applied.
declare const __AIUI_VERSION__: string;
const VERSION = typeof __AIUI_VERSION__ === "string" ? __AIUI_VERSION__ : "0.0.0+dev";

/**
 * Build the `aiui` command tree.
 *
 * Kept separate from the executable entrypoint (cli.ts) so tests can construct
 * and inspect the program without actually running it.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("aiui")
    .description("ai ui frontends — thin launchers for Claude and Vite")
    .version(VERSION);

  program.command("claude").description("launch Claude").action(runClaude);

  program.command("vite").description("launch Vite").action(runVite);

  return program;
}
