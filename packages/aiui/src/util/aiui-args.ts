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
   * The `--aiui-mcp <tag>` value, if provided — the tag of the running channel
   * MCP server to target (e.g. so `aiui vite` connects to a specific session).
   */
  mcp?: string;
  /**
   * `--aiui-chrome` was passed: force the Chrome DevTools MCP on even where it
   * would default off (i.e. under CI).
   */
  chrome: boolean;
  /**
   * `--aiui-no-chrome` was passed: don't attach the Chrome DevTools MCP to the
   * session. (Distinct from claude's own `--no-chrome`, which disables Claude
   * Code's built-in browser integration and forwards via passthrough.)
   */
  noChrome: boolean;
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
   * The `--aiui-chrome-profile <name>` value, if provided — which named Chrome
   * profile (user data dir under `.aiui-cache/chrome/`) to launch with.
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
   * flag `aiui browser --tunnel` prints for the remote side; it overrides
   * `chrome.browserUrl` in config for this launch.
   */
  browserUrl?: string;
  /**
   * Names collected from repeatable `--aiui-sidecar <name>` flags — session
   * sidecars to force-enable even when they wouldn't auto-detect for this
   * project (e.g. `--aiui-sidecar paint`).
   */
  sidecar: string[];
  /**
   * Names collected from repeatable `--aiui-no-sidecar <name>` flags — session
   * sidecars to disable for this run. Disable wins over enable.
   */
  noSidecar: string[];
  /**
   * The `--aiui-bind <loopback|host>` value, if provided — where the channel's
   * web backend binds for this launch, overriding `channel.bind` in config.
   * `host` is the trusted-LAN posture: the whole (unauthenticated) channel
   * surface, iPad paint page included, becomes reachable from the network.
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
 *  - `--aiui-mcp <tag>` / `--aiui-mcp=<tag>` — the tag of the running channel
 *    MCP server to target (e.g. which session `aiui vite` should connect to).
 *  - `--aiui-chrome` / `--aiui-no-chrome` — force the Chrome DevTools MCP on
 *    (even under CI) / leave it off. Passing both is an error.
 *  - `--aiui-browser` / `--aiui-no-browser` — force opening the page in the
 *    session browser (even in CI/headless environments) / never open one.
 *    Passing both is an error.
 *  - `--aiui-chrome-profile <name>` — launch Chrome with the named profile
 *    (created on first use under `.aiui-cache/chrome/<name>`).
 *  - `--aiui-chrome-data-dir <path>` — launch Chrome with an explicit user data
 *    dir instead of a named profile. Mutually exclusive with the above.
 *  - `--aiui-browser-url <url>` — attach the Chrome DevTools MCP to this
 *    endpoint (e.g. a tunneled remote browser) instead of managing one.
 *  - `--aiui-sidecar <name>` / `--aiui-no-sidecar <name>` — force-enable /
 *    disable a session sidecar by name. Both are repeatable and accumulate;
 *    disable wins over enable when the same name appears in both.
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
  let chrome = false;
  let noChrome = false;
  let browser = false;
  let noBrowser = false;
  let chromeProfile: string | undefined;
  let chromeDataDir: string | undefined;
  let browserUrl: string | undefined;
  const sidecar: string[] = [];
  const noSidecar: string[] = [];
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
      case "--aiui-chrome": {
        if (value !== undefined) {
          throw new Error("--aiui-chrome takes no value");
        }
        chrome = true;
        break;
      }
      case "--aiui-no-chrome": {
        if (value !== undefined) {
          throw new Error("--aiui-no-chrome takes no value");
        }
        noChrome = true;
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
      case "--aiui-chrome-profile": {
        if (value === undefined) {
          value = args[++i];
        }
        if (!value) {
          throw new Error("--aiui-chrome-profile requires a non-empty value");
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
      case "--aiui-sidecar": {
        if (value === undefined) {
          value = args[++i];
        }
        if (!value) {
          throw new Error("--aiui-sidecar requires a non-empty value");
        }
        sidecar.push(value);
        break;
      }
      case "--aiui-no-sidecar": {
        if (value === undefined) {
          value = args[++i];
        }
        if (!value) {
          throw new Error("--aiui-no-sidecar requires a non-empty value");
        }
        noSidecar.push(value);
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

  if (chrome && noChrome) {
    throw new Error("--aiui-chrome and --aiui-no-chrome are mutually exclusive");
  }
  if (browser && noBrowser) {
    throw new Error("--aiui-browser and --aiui-no-browser are mutually exclusive");
  }
  if (chromeProfile !== undefined && chromeDataDir !== undefined) {
    throw new Error("--aiui-chrome-profile and --aiui-chrome-data-dir are mutually exclusive");
  }
  if (browserUrl !== undefined && (chromeProfile !== undefined || chromeDataDir !== undefined)) {
    throw new Error(
      "--aiui-browser-url means the browser is managed elsewhere — it can't be combined " +
        "with --aiui-chrome-profile or --aiui-chrome-data-dir",
    );
  }

  return {
    tag,
    mcp,
    chrome,
    noChrome,
    browser,
    noBrowser,
    chromeProfile,
    chromeDataDir,
    browserUrl,
    sidecar,
    noSidecar,
    bind,
    passthrough,
  };
}
