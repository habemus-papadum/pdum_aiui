/**
 * Splitting aiui's own flags out of an otherwise pass-through arg list.
 *
 * The `aiui claude` (and future) subcommands forward nearly everything to the
 * underlying tool. The exception is aiui's own options, which by convention all
 * begin with `--aiui-` so they're unambiguously distinguishable from flags meant
 * for the wrapped command (e.g. claude's `--resume`).
 */
import { CHANNEL_BINDS, type ChannelBind } from "./config-schema";

export interface AiuiArgs {
  /** The `--aiui-tag <tag>` value, if provided (the channel/MCP session tag). */
  tag?: string;
  /**
   * The `--aiui-mcp <tag>` value, if provided. RETIRED: no command consumes it
   * anymore (`aiui vite` stopped wiring a channel, 2026-07-17); the flag is
   * still parsed so old scripts get a loud "ignored" warning instead of an
   * unknown-option error. Drop it once the migration window closes.
   */
  mcp?: string;
  /**
   * `--aiui-session-browser` was passed: force the shared session browser (and
   * the Chrome DevTools MCP that drives it) ON even where it would default off
   * (i.e. under CI).
   */
  sessionBrowser: boolean;
  /**
   * `--aiui-no-session-browser` was passed: launch WITHOUT the shared session
   * browser — no browser is started and the Chrome DevTools MCP is not attached
   * (the two are one integration; this governs both). Distinct from claude's
   * own `--no-chrome`, which disables Claude Code's built-in browser
   * integration and forwards via passthrough.
   */
  noSessionBrowser: boolean;
  /**
   * `--aiui-browser` was passed: open the wrapped tool's page in the session
   * browser even where it would default off (CI / headless environments —
   * e.g. `aiui vite` on a machine whose port *is* getting forwarded to one
   * with a display).
   */
  browser: boolean;
  /**
   * `--aiui-no-browser` was passed: skip all session-browser activity (no
   * tab opened, no browser launched) for this run.
   */
  noBrowser: boolean;
  /**
   * The `--aiui-profile <name>` value, if provided — which browser profile
   * (user data dir under `~/.cache/aiui/userdata/`) to launch with.
   */
  chromeProfile?: string;
  /**
   * The `--aiui-chrome-data-dir <path>` value, if provided — an explicit Chrome
   * user data dir, bypassing the named-profile convention entirely.
   */
  chromeDataDir?: string;
  /**
   * The `--aiui-browser-url <url>` value, if provided — attach the Chrome
   * DevTools MCP to this endpoint and manage no browser locally. This is the
   * flag `aiui remote` prints for the remote side; it overrides
   * `chrome.browserUrl` in config for this launch.
   */
  browserUrl?: string;
  /**
   * The `--aiui-bind <loopback|host>` value, if provided — where the channel's
   * web backend binds for this launch, overriding `channel.bind` in config.
   * `host` is the trusted-LAN posture: the whole (unauthenticated) channel
   * surface, iPad pencil page included, becomes reachable from the network.
   */
  bind?: ChannelBind;
  /** Everything else, to forward verbatim to the wrapped tool. */
  passthrough: string[];
}

const AIUI_PREFIX = "--aiui-";

/**
 * Detect a standalone `--help`/`-h` or `--version`/`-v` in a passthrough list.
 *
 * The wrapper commands treat these as **inert**: no config read, no browser or
 * Chrome-for-Testing activity, no channel discovery — just aiui's own
 * help/version, then the flag forwarded to the wrapped tool so its output
 * follows. Only exact argument matches count; a flag *value* that happens to
 * contain the text (e.g. `-p "explain --help"`) doesn't trigger it.
 */
export function infoFlag(passthrough: string[]): "help" | "version" | undefined {
  if (passthrough.includes("--help") || passthrough.includes("-h")) {
    return "help";
  }
  if (passthrough.includes("--version") || passthrough.includes("-v")) {
    return "version";
  }
  return undefined;
}

/**
 * Partition `args` into aiui's own options and the rest.
 *
 * Recognised aiui options:
 *  - `--aiui-tag <tag>` / `--aiui-tag=<tag>` — the channel/MCP session tag,
 *    forwarded to the channel server (and usable with `quick --tag`).
 *  - `--aiui-mcp <tag>` / `--aiui-mcp=<tag>` — RETIRED (parsed only to warn;
 *    see the field doc).
 *  - `--aiui-session-browser` / `--aiui-no-session-browser` — force the shared
 *    session browser + its Chrome DevTools MCP on (even under CI) / launch
 *    without either (no browser started). Passing both is an error.
 *  - `--aiui-browser` / `--aiui-no-browser` — force opening the page in the
 *    session browser (even in CI/headless environments) / never open one.
 *    Passing both is an error.
 *  - `--aiui-profile <name>` — launch with the named browser profile
 *    (created on first use under `~/.cache/aiui/userdata/<name>`).
 *  - `--aiui-chrome-data-dir <path>` — launch Chrome with an explicit user data
 *    dir instead of a named profile. Mutually exclusive with the above.
 *  - `--aiui-browser-url <url>` — attach the Chrome DevTools MCP to this
 *    endpoint (e.g. a tunneled remote browser) instead of managing one.
 *  - `--aiui-bind <loopback|host>` — where the channel's web backend binds for
 *    this launch (see `channel.bind` in the config guide). Any other value is
 *    an error.
 *
 * Any other `--aiui-*` flag throws, so a typo surfaces loudly instead of being
 * silently dropped or leaking into the child command.
 */
export function splitAiuiArgs(args: string[]): AiuiArgs {
  let tag: string | undefined;
  let mcp: string | undefined;
  let sessionBrowser = false;
  let noSessionBrowser = false;
  let browser = false;
  let noBrowser = false;
  let chromeProfile: string | undefined;
  let chromeDataDir: string | undefined;
  let browserUrl: string | undefined;
  let bind: ChannelBind | undefined;
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
      case "--aiui-session-browser": {
        if (value !== undefined) {
          throw new Error("--aiui-session-browser takes no value");
        }
        sessionBrowser = true;
        break;
      }
      case "--aiui-no-session-browser": {
        if (value !== undefined) {
          throw new Error("--aiui-no-session-browser takes no value");
        }
        noSessionBrowser = true;
        break;
      }
      case "--aiui-browser": {
        if (value !== undefined) {
          throw new Error("--aiui-browser takes no value");
        }
        browser = true;
        break;
      }
      case "--aiui-no-browser": {
        if (value !== undefined) {
          throw new Error("--aiui-no-browser takes no value");
        }
        noBrowser = true;
        break;
      }
      case "--aiui-profile": {
        if (value === undefined) {
          value = args[++i];
        }
        if (!value) {
          throw new Error("--aiui-profile requires a non-empty value");
        }
        chromeProfile = value;
        break;
      }
      case "--aiui-chrome-data-dir": {
        if (value === undefined) {
          value = args[++i];
        }
        if (!value) {
          throw new Error("--aiui-chrome-data-dir requires a non-empty value");
        }
        chromeDataDir = value;
        break;
      }
      case "--aiui-browser-url": {
        if (value === undefined) {
          value = args[++i];
        }
        if (!value) {
          throw new Error("--aiui-browser-url requires a non-empty value");
        }
        browserUrl = value;
        break;
      }
      case "--aiui-bind": {
        if (value === undefined) {
          value = args[++i];
        }
        if (!value || !(CHANNEL_BINDS as readonly string[]).includes(value)) {
          throw new Error(`--aiui-bind requires one of: ${CHANNEL_BINDS.join(", ")}`);
        }
        bind = value as ChannelBind;
        break;
      }
      default:
        throw new Error(`unknown aiui option: ${name}`);
    }
  }

  if (sessionBrowser && noSessionBrowser) {
    throw new Error("--aiui-session-browser and --aiui-no-session-browser are mutually exclusive");
  }
  if (browser && noBrowser) {
    throw new Error("--aiui-browser and --aiui-no-browser are mutually exclusive");
  }
  if (chromeProfile !== undefined && chromeDataDir !== undefined) {
    throw new Error("--aiui-profile and --aiui-chrome-data-dir are mutually exclusive");
  }
  if (browserUrl !== undefined && (chromeProfile !== undefined || chromeDataDir !== undefined)) {
    throw new Error(
      "--aiui-browser-url means the browser is managed elsewhere — it can't be combined " +
        "with --aiui-profile or --aiui-chrome-data-dir",
    );
  }

  return {
    tag,
    mcp,
    sessionBrowser,
    noSessionBrowser,
    browser,
    noBrowser,
    chromeProfile,
    chromeDataDir,
    browserUrl,
    bind,
    passthrough,
  };
}
