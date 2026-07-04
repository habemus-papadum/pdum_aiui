import { resolve } from "node:path";
import { execa } from "execa";
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
 * Any `passthrough` args (e.g. from `aiui claude --resume`) are appended to the
 * generated command line, so callers can drive the underlying `claude`.
 */
export async function runClaude(passthrough: string[] = []): Promise<void> {
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
  // installed) and append its `mcp` subcommand.
  const channel = resolvePackageCli(CHANNEL_PKG);
  const mcpConfig = JSON.stringify({
    mcpServers: {
      [CHANNEL_SERVER_ID]: { command: channel.command, args: [...channel.args, "mcp"] },
    },
  });

  const args = [
    "--dangerously-skip-permissions",
    "--chrome",
    "--mcp-config",
    mcpConfig,
    "--plugin-dir",
    plugin,
    // Custom channels are a research preview and not on the approved allowlist,
    // so opt this session into loading ours as a development channel.
    "--dangerously-load-development-channels",
    `server:${CHANNEL_SERVER_ID}`,
  ];

  // DRY RUN — we don't launch Claude yet. Prefix the whole command with `echo`
  // so running `aiui claude` just prints the exact command line that *would* be
  // run (the leading `claude` included). To actually launch, drop the "echo" /
  // "claude" prefix and exec the first token as the program instead.
  await execa("echo", ["claude", ...args, ...passthrough], { stdio: "inherit" });
}
