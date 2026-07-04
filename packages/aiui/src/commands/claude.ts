import { execa } from "execa";
import { printError } from "../util/ui";
import { commandExists } from "../util/which";

// The inline MCP server id for our custom channel. It is reused twice: as the
// key under `mcpServers` in `--mcp-config`, and as the `server:<id>` entry that
// opts the session into loading the development channel.
const CHANNEL_SERVER_ID = "aiui";

/**
 * Launch Claude Code wired up with the aiui channel and plugin.
 *
 * Builds a `claude` command line and hands the terminal over to it. The two
 * sibling CLIs — `aiui-claude-channel` (the custom MCP channel) and
 * `aiui-claude-plugin` (the plugin directory locator) — are assumed to be on
 * the PATH; only `claude` itself is checked, since everything here launches it.
 */
export async function runClaude(): Promise<void> {
  if (!commandExists("claude")) {
    printError(
      "`claude` was not found on your PATH",
      "Install Claude Code and make sure the `claude` command is available, then try again.",
    );
    process.exitCode = 1;
    return;
  }

  // Ask the plugin CLI where its bundled plugin directory lives (this works
  // whether aiui-claude-plugin is installed from npm or running from source).
  const { stdout: pluginDir } = await execa("aiui-claude-plugin", ["path"]);

  // Run the custom channel via its own CLI rather than npx — the
  // aiui-claude-channel bin is assumed to be on the PATH.
  const mcpConfig = JSON.stringify({
    mcpServers: {
      [CHANNEL_SERVER_ID]: { command: "aiui-claude-channel", args: ["mcp"] },
    },
  });

  const args = [
    "--dangerously-skip-permissions",
    "--chrome",
    "--mcp-config",
    mcpConfig,
    "--plugin-dir",
    pluginDir.trim(),
    // Custom channels are a research preview and not on the approved allowlist,
    // so opt this session into loading ours as a development channel.
    "--dangerously-load-development-channels",
    `server:${CHANNEL_SERVER_ID}`,
  ];

  // `stdio: "inherit"` hands the terminal to Claude (it owns stdin/stdout/stderr
  // directly). `reject: false` lets us forward Claude's exit code as our own
  // instead of surfacing a non-zero exit as an aiui error.
  const result = await execa("claude", args, { stdio: "inherit", reject: false });
  if (typeof result.exitCode === "number") {
    process.exitCode = result.exitCode;
  }
}
