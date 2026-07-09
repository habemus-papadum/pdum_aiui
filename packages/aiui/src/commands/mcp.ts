import { execa } from "execa";
import {
  applyChannelLaunchArgs,
  isChannelLaunch,
  resolveChannelLaunch,
} from "../util/channel-launch";
import { loadAiuiConfig } from "../util/config";
import { type CliInvocation, resolvePackageCli } from "../util/resolve-cli";
import { printError } from "../util/ui";

const CHANNEL_PKG = "@habemus-papadum/aiui-claude-channel";

/**
 * Forward to the aiui Claude channel CLI (`aiui-claude-channel`).
 *
 * `aiui mcp <args...>` runs the channel package's own CLI with `<args...>`, so
 * `aiui mcp quick --tag <t> --message "..."` is exactly
 * `aiui-claude-channel quick --tag <t> --message "..."`. This surfaces the
 * user-facing channel commands under `aiui` without moving them out of the
 * package that owns the MCP server Claude Code spawns.
 *
 * **One thing is not verbatim.** The subcommands that *are* a channel process —
 * `serve` (standalone debug channel) and `mcp` (the stdio MCP server) — get the
 * same config-derived `--bind` and `--sidecars` that `aiui claude` computes when
 * it tells Claude Code how to spawn the channel (see util/channel-launch). Both
 * ways of starting a channel therefore honor `channel.bind` and `sidecars.*`
 * identically. Without this, a standalone `aiui mcp serve` had no `/paint/`
 * route — the channel mounts only the sidecars it is handed, and a verbatim
 * forward handed it none. Flags you pass explicitly always win. Every other
 * subcommand (`quick`, `config`) talks to a channel someone *else* is running
 * and forwards untouched.
 *
 * Like `aiui vite`, the channel CLI is a declared dependency, so we resolve it
 * from node_modules (tsx-from-source in a dev checkout, the built `dist` when
 * installed; see {@link resolvePackageCli}) rather than looking on the PATH.
 */
export async function runMcp(passthrough: string[] = []): Promise<void> {
  let channel: CliInvocation;
  try {
    channel = resolvePackageCli(CHANNEL_PKG);
  } catch {
    printError(
      "The aiui Claude channel CLI is not available",
      "`@habemus-papadum/aiui-claude-channel` should be installed as a dependency of aiui — try reinstalling.",
    );
    process.exitCode = 1;
    return;
  }

  // Only resolve when this invocation actually starts a channel: the sidecar
  // registry does real module resolution (and warns when a sidecar package is
  // missing), which `quick`/`config` have no business triggering. The channel
  // process inherits this cwd, so the project root it hosts sidecars for is ours.
  const args = isChannelLaunch(passthrough)
    ? applyChannelLaunchArgs(
        passthrough,
        resolveChannelLaunch({ root: process.cwd(), config: loadAiuiConfig() }),
      )
    : passthrough;

  // stdio inherit so interactive channel commands (e.g. `quick`'s selector) own
  // the terminal; reject:false so a non-zero child exit becomes our exit code.
  const result = await execa(channel.command, [...channel.args, ...args], {
    stdio: "inherit",
    reject: false,
  });
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}
