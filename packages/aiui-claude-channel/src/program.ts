import { Command, InvalidArgumentError } from "commander";
import { runConfig } from "./commands/config";
import { runMcp } from "./commands/mcp";
import { runQuick } from "./commands/quick";
import { parsePort, runServe } from "./commands/serve";

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

  program
    .command("mcp")
    .description("launch the MCP channel server over stdio")
    .option("--tag <tag>", "session tag to advertise (defaults to a generated UUID)")
    .option(
      "--launch-info <json>",
      "launcher-provided session summary (browser/DevTools MCP wiring), surfaced at /debug/api/info",
    )
    .option("--sidecars <json>", "JSON array of session sidecar descriptors to host")
    .action(runMcp);

  program
    .command("quick")
    .description("pick a running channel server and send it a prompt (end-to-end test)")
    .option("--tag <tag>", "target the server with this tag, skipping the selector")
    .option("-m, --message <text>", "prompt to send, skipping the interactive text prompt")
    .option("--ws", "send over the /ws websocket protocol instead of POST /prompt")
    .action(runQuick);

  program
    .command("serve")
    .description(
      "run a standalone debug channel server (no MCP, no registry) that prints lowered prompts to stdout",
    )
    .option("--tag <tag>", "label used in stderr logging (a debug server is never registered)")
    .option("--record", "append every frame-log entry as JSONL under .aiui-cache/recordings/")
    // The validator is the pure parsePort (tested in serve.test.ts); re-wrapped
    // here so commander renders a bad value as a usage error, not a crash.
    .option(
      "--port <port>",
      "bind this loopback port instead of an OS-assigned one (fails if taken)",
      (value) => {
        try {
          return parsePort(value);
        } catch (error) {
          throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
        }
      },
    )
    // Discard the handle: the CLI just lets the server run until a signal.
    .action(async (options) => {
      await runServe(options);
    });

  program.command("config").description("print the channel config as JSON").action(runConfig);

  return program;
}
