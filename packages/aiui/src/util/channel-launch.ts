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
 * The second path used to forward its arguments verbatim, so it never computed
 * the two settings that the first path derives from config — where the web
 * backend binds (`channel.bind`) and which session sidecars to host
 * (`sidecars.*`). The visible consequence: a standalone `serve` channel had no
 * `/paint/` route, because {@link resolveSidecars} was never called and the
 * channel only mounts sidecars it is handed. That is what this module fixes —
 * both launchers now resolve the same {@link ChannelLaunch} and emit the same
 * flags, so a standalone channel is configured exactly like a session's.
 *
 * What deliberately does NOT live here: `--launch-info` (a summary of *how a
 * Claude Code session was assembled* — browser wiring, key preflight — which a
 * direct launch has nothing to say about, and which `serve` does not even
 * accept), and `--tag` / `--name` / `--port`, which are per-invocation identity
 * rather than durable configuration.
 */

import type { AiuiConfig, ChannelBind } from "./config";
import { type ResolveSidecarsDeps, resolveSidecars, type SidecarDescriptor } from "./sidecars";

/** Everything a launcher knows that can influence the channel's configuration. */
export interface ChannelLaunchInput {
  /** Project root the sidecars are resolved against (the channel inherits this cwd). */
  root: string;
  /** Merged user + project config (`util/config`). */
  config: AiuiConfig;
  /** An explicit per-launch bind (`--aiui-bind`, or `serve`'s own `--bind`). */
  bind?: ChannelBind;
  /** Names from repeatable `--aiui-sidecar` — force-enable. */
  sidecar?: string[];
  /** Names from repeatable `--aiui-no-sidecar` — disable. Beats enable. */
  noSidecar?: string[];
}

/** The resolved settings, ready to be rendered as channel CLI flags. */
export interface ChannelLaunch {
  bind: ChannelBind;
  sidecars: SidecarDescriptor[];
}

/**
 * Resolve the channel's bind and sidecar set for a launch.
 *
 * Both settings follow the same three-tier precedence the docs promise:
 * per-launch flag, then durable config, then the built-in default
 * (`loopback`; sidecar auto-detection).
 */
export function resolveChannelLaunch(
  input: ChannelLaunchInput,
  deps: ResolveSidecarsDeps = {},
): ChannelLaunch {
  const bind = input.bind ?? input.config.channel?.bind ?? "loopback";

  const enable = [...(input.sidecar ?? [])];
  const disable = [...(input.noSidecar ?? [])];
  // Fold the durable `sidecars.*` settings in underneath the flags: a
  // per-launch flag for a given name beats that name's config entry, and
  // silence in config leaves auto-detection to decide.
  for (const [name, on] of Object.entries(input.config.sidecars ?? {})) {
    if (on === undefined || enable.includes(name) || disable.includes(name)) {
      continue;
    }
    (on ? enable : disable).push(name);
  }

  return { bind, sidecars: resolveSidecars(input.root, { enable, disable }, deps) };
}

/**
 * Render a {@link ChannelLaunch} as flags for the channel CLI. Both the `mcp`
 * and `serve` subcommands accept exactly this pair (see the channel's
 * program.ts); `--sidecars` is omitted when empty, since the channel
 * distinguishes "no descriptors" from "the flag was never passed".
 */
export function channelLaunchFlags(launch: ChannelLaunch): string[] {
  const flags = ["--bind", launch.bind];
  if (launch.sidecars.length > 0) {
    flags.push("--sidecars", JSON.stringify(launch.sidecars));
  }
  return flags;
}

/**
 * The channel subcommands that *are a channel process* — the ones that accept
 * `--bind` and `--sidecars`, and so want the config-derived defaults. Everything
 * else the channel CLI offers (`quick`, `config`) talks to a channel someone
 * else is running, and forwards verbatim.
 */
const CONFIGURABLE_SUBCOMMANDS = new Set(["serve", "mcp"]);

/** Whether `flag` (e.g. `--bind`) was already given, in either `--x v` or `--x=v` form. */
function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * Whether `aiui mcp <args...>` will start a channel process, and so wants the
 * config-derived settings. Callers use this to avoid the cost (and the
 * "sidecar failed to resolve" warnings) of {@link resolveChannelLaunch} for the
 * subcommands that merely talk to a channel someone else is running.
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
 * --bind host` means `host` no matter what config says, and an explicit
 * `--sidecars` replaces the computed set wholesale (that is the escape hatch
 * for hosting something the CLI's registry doesn't know how to build).
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
