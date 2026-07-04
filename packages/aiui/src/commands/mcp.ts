import { execa } from "execa";
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

  // stdio inherit so interactive channel commands (e.g. `quick`'s selector) own
  // the terminal; reject:false so a non-zero child exit becomes our exit code.
  const result = await execa(channel.command, [...channel.args, ...passthrough], {
    stdio: "inherit",
    reject: false,
  });
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}
