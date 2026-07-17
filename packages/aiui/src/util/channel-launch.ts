/**
 * How a channel process gets configured, in one place.
 *
 * There are two ways the channel server comes up, and they must agree:
 *
 *  - **`aiui claude`** builds an argv for the channel's `mcp` subcommand and
 *    hands it to Claude Code inside `--mcp-config`, which spawns it.
 *  - **`aiui mcp serve` / `aiui mcp mcp`** run the very same channel CLI
 *    directly, with no Claude Code anywhere in the loop.
 *
 * The one durable setting they must both derive from config is where the web
 * backend binds (`channel.bind`) — the trusted-LAN posture. The second path
 * used to forward its arguments verbatim and so never computed it; this module
 * is what makes both paths resolve the same {@link ChannelLaunch} and emit the
 * same `--bind` flag, so a standalone channel binds exactly like a session's.
 *
 * Which sidecars a channel hosts is NOT decided here anymore. The channel
 * imports and mounts its own standard set (intent, bar, pencil — see the
 * channel's standard-sidecars.ts), so there is nothing to pass: every channel
 * hosts all four, and `channel.bind` alone decides whether a remote device can
 * reach them.
 *
 * What else deliberately does NOT live here: `--launch-info` (a summary of *how
 * a Claude Code session was assembled* — browser wiring, key preflight — which
 * a direct launch has nothing to say about, and which `serve` does not even
 * accept), and `--tag` / `--name` / `--port`, which are per-invocation identity
 * rather than durable configuration.
 */

import type { AiuiConfig, ChannelBind } from "./config";

/** Everything a launcher knows that can influence the channel's configuration. */
export interface ChannelLaunchInput {
  /** Merged user + project config (`util/config`). */
  config: AiuiConfig;
  /** An explicit per-launch bind (`--aiui-bind`, or `serve`'s own `--bind`). */
  bind?: ChannelBind;
}

/** The resolved settings, ready to be rendered as channel CLI flags. */
export interface ChannelLaunch {
  bind: ChannelBind;
}

/**
 * Resolve the channel's bind for a launch. Follows the three-tier precedence
 * the docs promise: per-launch flag, then durable config, then the built-in
 * default (`loopback`).
 */
export function resolveChannelLaunch(input: ChannelLaunchInput): ChannelLaunch {
  return { bind: input.bind ?? input.config.channel?.bind ?? "loopback" };
}

/**
 * Render a {@link ChannelLaunch} as flags for the channel CLI. Both the `mcp`
 * and `serve` subcommands accept `--bind` (see the channel's program.ts).
 */
export function channelLaunchFlags(launch: ChannelLaunch): string[] {
  return ["--bind", launch.bind];
}

/**
 * The channel subcommands that *are a channel process* — the ones that accept
 * `--bind`, and so want the config-derived default. Everything else the channel
 * CLI offers (`quick`, `config`) talks to a channel someone else is running and
 * forwards verbatim.
 */
const CONFIGURABLE_SUBCOMMANDS = new Set(["serve", "mcp"]);

/** Whether `flag` (e.g. `--bind`) was already given, in either `--x v` or `--x=v` form. */
function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * Whether `aiui mcp <args...>` will start a channel process, and so wants the
 * config-derived settings. Callers use this to leave the subcommands that
 * merely talk to a channel someone else is running (`quick`, `config`)
 * untouched.
 */
export function isChannelLaunch(args: string[]): boolean {
  // The subcommand is the first bare token; `aiui mcp --help` has none.
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  return subcommand !== undefined && CONFIGURABLE_SUBCOMMANDS.has(subcommand);
}

/**
 * Apply the config-derived channel settings to a raw `aiui mcp <args...>`
 * invocation.
 *
 * Returns `args` untouched unless its subcommand actually launches a channel.
 * A setting the caller named explicitly is never overridden — `aiui mcp serve
 * --bind host` means `host` no matter what config says.
 */
export function applyChannelLaunchArgs(args: string[], launch: ChannelLaunch): string[] {
  if (!isChannelLaunch(args)) {
    return args;
  }

  // channelLaunchFlags emits strictly `[--name, value]` pairs. Skip any pair the
  // caller already supplied, rather than passing the flag twice and leaving
  // commander's last-wins to silently pick ours.
  const flags = channelLaunchFlags(launch);
  const out = [...args];
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (!hasFlag(args, flag)) {
      out.push(flag, value);
    }
  }
  return out;
}
