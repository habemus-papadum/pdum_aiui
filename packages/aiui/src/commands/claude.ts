import { resolve } from "node:path";
import { execa } from "execa";
import { splitAiuiArgs } from "../util/aiui-args";
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
  const { tag, noChrome, passthrough } = splitAiuiArgs(rawArgs);

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

  const args = ["--dangerously-skip-permissions"];
  // `--chrome` attaches Claude to a real browser. In a headless/CI run or the
  // test harness there's nothing to attach to, and Claude will even prompt at
  // startup if it *detects* a browser extension — so `--aiui-no-chrome` passes
  // Claude's own `--no-chrome`, which both drops the integration and suppresses
  // that prompt.
  args.push(noChrome ? "--no-chrome" : "--chrome");
  args.push(
    "--mcp-config",
    mcpConfig,
    "--plugin-dir",
    plugin,
    // Custom channels are a research preview and not on the approved allowlist,
    // so opt this session into loading ours as a development channel.
    "--dangerously-load-development-channels",
    `server:${CHANNEL_SERVER_ID}`,
  );

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
