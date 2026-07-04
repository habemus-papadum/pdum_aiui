/**
 * Splitting aiui's own flags out of an otherwise pass-through arg list.
 *
 * The `aiui claude` (and future) subcommands forward nearly everything to the
 * underlying tool. The exception is aiui's own options, which by convention all
 * begin with `--aiui-` so they're unambiguously distinguishable from flags meant
 * for the wrapped command (e.g. claude's `--resume`).
 */

export interface AiuiArgs {
  /** The `--aiui-tag <tag>` value, if provided (the channel/MCP session tag). */
  tag?: string;
  /**
   * The `--aiui-mcp <tag>` value, if provided — the tag of the running channel
   * MCP server to target (e.g. so `aiui vite` connects to a specific session).
   */
  mcp?: string;
  /**
   * `--aiui-no-chrome` was passed. Currently a no-op — `aiui claude` always
   * launches Claude with `--no-chrome` now — kept as a recognized flag for when
   * we wire up the Chrome DevTools MCP and it gets real meaning again.
   */
  noChrome: boolean;
  /** Everything else, to forward verbatim to the wrapped tool. */
  passthrough: string[];
}

const AIUI_PREFIX = "--aiui-";

/**
 * Partition `args` into aiui's own options and the rest.
 *
 * Recognised aiui options:
 *  - `--aiui-tag <tag>` / `--aiui-tag=<tag>` — the channel/MCP session tag,
 *    forwarded to the channel server (and usable with `quick --tag`).
 *  - `--aiui-mcp <tag>` / `--aiui-mcp=<tag>` — the tag of the running channel
 *    MCP server to target (e.g. which session `aiui vite` should connect to).
 *  - `--aiui-no-chrome` — accepted but currently a no-op (Claude is always
 *    launched with `--no-chrome`); reserved for future Chrome DevTools MCP use.
 *
 * Any other `--aiui-*` flag throws, so a typo surfaces loudly instead of being
 * silently dropped or leaking into the child command.
 */
export function splitAiuiArgs(args: string[]): AiuiArgs {
  let tag: string | undefined;
  let mcp: string | undefined;
  let noChrome = false;
  const passthrough: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith(AIUI_PREFIX)) {
      passthrough.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);

    switch (name) {
      case "--aiui-tag": {
        if (value === undefined) {
          value = args[++i];
        }
        if (!value) {
          throw new Error("--aiui-tag requires a non-empty value");
        }
        tag = value;
        break;
      }
      case "--aiui-mcp": {
        if (value === undefined) {
          value = args[++i];
        }
        if (!value) {
          throw new Error("--aiui-mcp requires a non-empty value");
        }
        mcp = value;
        break;
      }
      case "--aiui-no-chrome": {
        if (value !== undefined) {
          throw new Error("--aiui-no-chrome takes no value");
        }
        noChrome = true;
        break;
      }
      default:
        throw new Error(`unknown aiui option: ${name}`);
    }
  }

  return { tag, mcp, noChrome, passthrough };
}
