/**
 * `aiui debug` — open the channel **console** for a running channel.
 *
 * The console is the channel's own dashboard, served at its root (the
 * `aiui-console` sidecar): channel + launch + connected-Chrome info, and links
 * to the pencil client, the standalone panel, and the trace debugger. So this
 * command no longer stands up its own Vite server — it picks a running channel
 * (the same registry + selector the rest of the CLI uses; a lone channel is
 * taken directly, several prompt) and opens the channel URL in the **session
 * browser** (the Chrome-for-Testing window `aiui claude` and `aiui open` use).
 * The root redirects to the dashboard; the trace debugger is one click away.
 */
import { listMcpServers, selectMcpServer } from "@habemus-papadum/aiui-claude-channel";
import chalk from "chalk";
import { splitAiuiArgs } from "../util/aiui-args";
import { resolveChannelTarget } from "../util/channel-target";
import { printError } from "../util/ui";
import { openAppInBrowser } from "./vite";

export interface DebugOptions {
  /** Target a channel by its registry tag instead of the interactive selector. */
  mcp?: string;
  /** Open the browser at the console (default true; `--no-open` skips). */
  open?: boolean;
}

export async function runDebug(opts: DebugOptions = {}): Promise<void> {
  const target = resolveChannelTarget(listMcpServers(), opts.mcp);
  if (target.error) {
    printError("Could not resolve an aiui channel", target.error);
    process.exitCode = 1;
    return;
  }
  const server = target.select ? await selectMcpServer(target.select) : target.server;
  if (!server) {
    console.log("No running aiui channel to open — start one with `aiui claude`.");
    process.exitCode = 1;
    return;
  }

  // The channel root redirects to the console dashboard (the console sidecar).
  const url = `http://127.0.0.1:${server.port}/`;
  console.log(`${chalk.cyan("aiui debug")} — the channel console`);
  console.log(`  ${chalk.bold(url)}`);
  console.log(
    chalk.dim(`  channel "${server.tag}" (${server.cwd}) on port ${server.port}`) +
      chalk.dim(` — the dashboard links to the trace debugger at /__aiui/debug.`),
  );

  if (opts.open === false) {
    return;
  }
  // The session browser (Chrome for Testing), non-interactive — no CfT prompt.
  await openAppInBrowser(url, splitAiuiArgs([]));
}
