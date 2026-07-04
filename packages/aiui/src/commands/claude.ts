import { resolve } from "node:path";
import { execa } from "execa";
import { splitAiuiArgs } from "../util/aiui-args";
import { nudgeChannelAck } from "../util/enter-nudge";
import { packageRoot, resolvePackageCli } from "../util/resolve-cli";
import { printError } from "../util/ui";
import { commandExists } from "../util/which";

const CHANNEL_PKG = "@habemus-papadum/aiui-claude-channel";
const PLUGIN_PKG = "@habemus-papadum/aiui-claude-plugin";

// The inline MCP server id for our custom channel. It is reused twice: as the
// key under `mcpServers` in `--mcp-config`, and as the `server:<id>` entry that
// opts the session into loading the development channel.
const CHANNEL_SERVER_ID = "aiui";

/**
 * Launch Claude Code wired up with the aiui channel and plugin.
 *
 * Builds a `claude` command line and hands the terminal over to it. The plugin
 * directory and the channel CLI are resolved from their dependencies to
 * absolute paths — no PATH lookups. In a dev checkout the channel runs straight
 * from its TypeScript source via tsx (no build step), and when installed from
 * npm it runs the built `dist` entry; see {@link resolvePackageCli}. Only
 * `claude` itself is checked on the PATH, since everything here launches it.
 *
 * Args are split into aiui's own options (those beginning with `--aiui-`) and
 * the rest, which forward verbatim to `claude`. So `aiui claude --resume` passes
 * `--resume` through, while `aiui claude --aiui-tag <uuid>` is consumed here to
 * tag the channel session (letting a test harness address the exact MCP server
 * it spawned via `quick --tag`). When no tag is given the channel server mints
 * its own UUID.
 */
export async function runClaude(rawArgs: string[] = []): Promise<void> {
  const { tag, passthrough } = splitAiuiArgs(rawArgs);

  if (!commandExists("claude")) {
    printError(
      "`claude` was not found on your PATH",
      "Install Claude Code and make sure the `claude` command is available, then try again.",
    );
    process.exitCode = 1;
    return;
  }

  // The plugin directory ships alongside its package (in both dev and installed
  // layouts), so resolve it from the package root.
  const plugin = resolve(packageRoot(PLUGIN_PKG), "plugin");

  // Resolve how to run the channel CLI (tsx-from-source in dev, dist when
  // installed) and append its `mcp` subcommand. A user-supplied `--aiui-tag`
  // is forwarded as the server's `--tag`; without one the server generates its
  // own UUID.
  const channel = resolvePackageCli(CHANNEL_PKG);
  const mcpArgs = [...channel.args, "mcp"];
  if (tag) {
    mcpArgs.push("--tag", tag);
  }
  const mcpConfig = JSON.stringify({
    mcpServers: {
      [CHANNEL_SERVER_ID]: { command: channel.command, args: mcpArgs },
    },
  });

  // We don't add `--chrome` or `--no-chrome`: whether to use Claude's browser
  // integration is the user's call, forwarded via passthrough (e.g.
  // `aiui claude --chrome`). Automated/CI contexts pass `--no-chrome` themselves
  // (see the e2e test harness) to skip the browser-detection startup prompt.
  const args = [
    "--dangerously-skip-permissions",
    "--mcp-config",
    mcpConfig,
    "--plugin-dir",
    plugin,
    // Custom channels are a research preview and not on the approved allowlist,
    // so opt this session into loading ours as a development channel.
    "--dangerously-load-development-channels",
    `server:${CHANNEL_SERVER_ID}`,
  ];

  // Loading our development channel makes Claude show a one-key acknowledgement
  // prompt at startup. In a real interactive session, best-effort press Enter on
  // the user's behalf (see nudgeChannelAck). Skip it when there's no TTY or in
  // print mode (`-p`/`--print`) — the prompt only appears in the interactive TUI,
  // and the harness drives its own keypresses over tmux.
  if (isInteractiveSession(passthrough)) {
    nudgeChannelAck();
  }

  // Hand the terminal over to Claude. stdio:"inherit" so the session owns the
  // terminal (and, when spawned by the test harness, so Claude's stdio is the
  // harness's captured pipes). reject:false so an interrupted/non-zero Claude
  // exit becomes our exit code rather than a thrown error.
  const result = await execa("claude", [...args, ...passthrough], {
    stdio: "inherit",
    reject: false,
  });
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}

/**
 * Whether this invocation will bring up Claude's interactive TUI — the only
 * context where the channel acknowledgement prompt appears. Requires a real
 * terminal on both ends and no print-mode flag.
 */
export function isInteractiveSession(passthrough: string[]): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  return !passthrough.some((arg) => arg === "-p" || arg === "--print");
}
