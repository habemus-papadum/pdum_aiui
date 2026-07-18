import { Command, InvalidArgumentError } from "commander";
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
/** `--mode` validator, shared by `mcp` and `serve` (dev = source, prod = built). */
function parseMode(value: string): "dev" | "prod" {
  if (value !== "dev" && value !== "prod") {
    throw new InvalidArgumentError("expected 'dev' or 'prod'");
  }
  return value;
}

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
    .option(
      "--bind <mode>",
      "bind the web backend to 'loopback' (127.0.0.1, default) or 'host' (0.0.0.0 — " +
        "every unauthenticated route becomes LAN-reachable; trusted networks only)",
      (value) => {
        if (value !== "loopback" && value !== "host") {
          throw new InvalidArgumentError("expected 'loopback' or 'host'");
        }
        return value;
      },
    )
    .option(
      "--mode <mode>",
      "force sidecar dev/prod mode: 'dev' (Vite dev servers, source) or 'prod' " +
        "(prebuilt static bundles). Default: derived from whether the channel runs from source",
      parseMode,
    )
    .option(
      "--no-page-tools-notify",
      "don't push 'page tools changed' notes into the session when the page-tool " +
        "directory changes (the tools/list_changed MCP notification is still sent)",
    )
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
      "run a standalone debug channel server (no MCP; registered as debug) that prints lowered prompts to stdout",
    )
    .option("--tag <tag>", "registry address + stderr/trace label (defaults to a UUID)")
    .option("--name <name>", 'display name selectors show for this server (e.g. "aiui debug")')
    .option("--record", "append every frame-log entry as JSONL under .aiui-cache/recordings/")
    .option(
      "--bind <mode>",
      "bind the web backend to 'loopback' (127.0.0.1, default) or 'host' (0.0.0.0 — " +
        "every unauthenticated route becomes LAN-reachable; trusted networks only)",
      (value) => {
        if (value !== "loopback" && value !== "host") {
          throw new InvalidArgumentError("expected 'loopback' or 'host'");
        }
        return value;
      },
    )
    .option(
      "--mode <mode>",
      "force sidecar dev/prod mode: 'dev' (Vite dev servers) or 'prod' (prebuilt " +
        "static bundles). Default: derived from whether the channel runs from source",
      parseMode,
    )
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

  return program;
}
