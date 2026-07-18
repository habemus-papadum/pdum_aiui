import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChromeDevtoolsInfo, LaunchInfo } from "@habemus-papadum/aiui-claude-channel";
import {
  discoverSessionBrowser,
  isCi,
  launchSessionBrowser,
  sessionBrowserBinary,
} from "@habemus-papadum/aiui-util";
import { execa } from "execa";
import { type AiuiArgs, infoFlag, splitAiuiArgs } from "../util/aiui-args";
import { channelLaunchFlags, resolveChannelLaunch } from "../util/channel-launch";
import {
  CHROME_SERVER_ID,
  chromeDevtoolsEnabled,
  chromeMcpAttachServer,
  chromeMcpServer,
  findIntentClientExtension,
  maybeExtensionAutoloadHint,
  resolveChromeSettings,
  warnIntentClientState,
} from "../util/chrome";
import {
  type AiuiConfig,
  loadAiuiConfig,
  resolveManagedFlavor,
  resolveManageMode,
} from "../util/config";
import { ENTER_NUDGE_ENABLED, nudgeChannelAck } from "../util/enter-nudge";
import { ensureLaunchChoices } from "../util/first-run";
import { preflightGeminiKey, reportGeminiPreflight } from "../util/gemini-preflight";
import { syncManagedBrowser } from "../util/managed-browser";
import { preflightOpenAiKey, reportOpenAiPreflight } from "../util/openai-preflight";
import { packageRoot, resolvePackageCli } from "../util/resolve-cli";
import { printError, printWarning } from "../util/ui";
import { VERSION } from "../util/version";
import { commandExists } from "../util/which";
import { ensureProfileNativeHost } from "./extension";

const CHANNEL_PKG = "@habemus-papadum/aiui-claude-channel";
const PLUGIN_PKG = "@habemus-papadum/aiui-claude-plugin";

// The inline MCP server id for our custom channel. It is reused twice: as the
// key under `mcpServers` in `--mcp-config`, and as the `server:<id>` entry that
// opts the session into loading the development channel.
const CHANNEL_SERVER_ID = "aiui";

/**
 * Launch Claude Code wired up with the aiui channel, plugin, and (by default)
 * the Chrome DevTools MCP.
 *
 * Builds a `claude` command line and hands the terminal over to it. The plugin
 * directories and the channel CLI are resolved from their dependencies to
 * absolute paths — no PATH lookups. In a dev checkout the channel runs straight
 * from its TypeScript source via tsx (no build step), and when installed from
 * npm it runs the built `dist` entry; see {@link resolvePackageCli}. Only
 * `claude` itself is checked on the PATH, since everything here launches it.
 *
 * Args are split into aiui's own options (those beginning with `--aiui-`) and
 * the rest, which forward verbatim to `claude`. So `aiui claude --resume` passes
 * `--resume` through, while `aiui claude --aiui-tag <uuid>` is consumed here to
 * tag the channel session (letting a test harness address the exact MCP server
 * it spawned via `quick --tag`). When no tag is given the channel server mints
 * its own UUID.
 *
 * `--help` and `--version` are inert: aiui's own answer prints first, then the
 * flag forwards to claude so its output follows — and none of the launch
 * machinery (config, Chrome for Testing, session browser, channel) runs.
 */
export async function runClaude(rawArgs: string[] = []): Promise<void> {
  const aiuiArgs = splitAiuiArgs(rawArgs);
  const { tag, passthrough } = aiuiArgs;

  // `--help` / `--version` are inert: print aiui's own answer, then forward
  // the flag so claude's follows — two outputs back to back, and none of the
  // launch machinery (config, browser, Chrome for Testing, channel) runs.
  const info = infoFlag(passthrough);
  if (info) {
    if (info === "help") {
      printClaudeWrapperHelp();
    } else {
      console.log(`aiui ${VERSION}`);
    }
    await forwardToClaude(passthrough);
    return;
  }
  // Settings from ~/.cache/aiui/config.json + .aiui-cache/config.json (project
  // wins per key; flags win over both) — see util/config and docs/guide/config.
  let config = loadAiuiConfig();

  // A real TTY on both ends, not print mode, not CI: the only context where
  // aiui may prompt (first-run choices, CfT offers) or type into the terminal.
  const interactive = isInteractiveSession(passthrough) && !isCi();
  if (interactive) {
    // Settings that deserve a deliberate answer — skip-permissions, the enter
    // nudge, and the channel bind — are asked once, definitively, and persisted
    // to the user config; every later launch reads the choice silently.
    config = await ensureLaunchChoices(config);
  }

  // Preflight the OpenAI key the intent pipeline needs (transcription +
  // correction, which run in the spawned channel process — the key reaches
  // them through this environment). Interactive launches verify it against the
  // API and report any degradation once; CI/non-interactive only note presence
  // without touching the network. Either way the launch proceeds — a bad or
  // missing key leaves transcription/correction unavailable (the widget says
  // so; mock is the explicit offline choice), never a refusal. We keep only the
  // status (never the key) to thread into launch-info below.
  const openaiKey = await preflightOpenAiKey({ verify: interactive });
  if (interactive) {
    reportOpenAiPreflight(openaiKey);
  }
  // Same preflight for the Gemini key (the realtime submode's Gemini Live
  // engine, also channel-side). A bad key would otherwise surface as an opaque
  // closed WebSocket deep in a live session; a missing one is only a note —
  // the default transcription tiers don't need it.
  const geminiKey = await preflightGeminiKey({ verify: interactive });
  if (interactive) {
    reportGeminiPreflight(geminiKey);
  }

  if (!ensureClaudeOnPath()) {
    return;
  }

  // Plugins ship in the plugin package's marketplace/ (in both dev and
  // installed layouts). They're loaded directly with repeated `--plugin-dir`
  // flags — the marketplace manifest exists for marketplace installs later,
  // not as a required indirection here.
  const pluginsRoot = resolve(packageRoot(PLUGIN_PKG), "marketplace", "plugins");

  // Resolve how to run the channel CLI (tsx-from-source in dev, dist when
  // installed) and append its `mcp` subcommand. A user-supplied `--aiui-tag`
  // is forwarded as the server's `--tag`; without one the server generates its
  // own UUID.
  const channel = resolvePackageCli(CHANNEL_PKG);
  const mcpArgs = [...channel.args, "mcp"];
  if (tag) {
    mcpArgs.push("--tag", tag);
  }
  // Where the channel's web backend binds — resolved by the shared launcher
  // (util/channel-launch), so a standalone `aiui mcp serve` binds identically to
  // a session's channel. bind: loopback (the default) keeps every route
  // this-machine-only; host puts the whole unauthenticated surface — iPad
  // pencil page, prompt injection, /debug — on the network (the trusted-LAN posture;
  // asked at first run, see docs/guide/warning). The channel hosts its own
  // standard sidecar set regardless; the channel process inherits this session's
  // cwd, so the project root it roots them at is process.cwd().
  const launch = resolveChannelLaunch({ config, bind: aiuiArgs.bind });
  mcpArgs.push(...channelLaunchFlags(launch));
  const mcpServers: Record<string, { command: string; args: string[] }> = {
    [CHANNEL_SERVER_ID]: { command: channel.command, args: mcpArgs },
  };

  // By default the session also gets the Chrome DevTools MCP — off under CI,
  // `--aiui-no-chrome`, or `chrome.enabled: false`. In the default "attach"
  // mode the MCP shares a user-visible session browser (see aiui-util's
  // browser module);
  // "launch" mode keeps the browser private to the MCP and lazily started.
  let chromeInfo: ChromeDevtoolsInfo = { enabled: false };
  if (chromeDevtoolsEnabled(aiuiArgs, config.chrome)) {
    // `--aiui-browser-url` (printed by `aiui browser --tunnel` for the remote
    // side) beats a configured chrome.browserUrl for this launch.
    const chromeCfg = {
      ...config.chrome,
      ...(aiuiArgs.browserUrl ? { browserUrl: aiuiArgs.browserUrl } : {}),
    };
    const chrome = await chromeServerEntry(aiuiArgs, chromeCfg, interactive);
    mcpServers[CHROME_SERVER_ID] = chrome.entry;
    chromeInfo = chrome.info;
  }
  // Tell the channel server how this session was assembled. It surfaces this
  // at /debug/api/info, and the DevTools panel's Server tab renders it — the
  // first place to look when browser/MCP connectivity misbehaves.
  const launchInfo: LaunchInfo = {
    launcher: "aiui claude",
    chromeDevtools: chromeInfo,
    openaiKey,
    geminiKey,
  };
  mcpArgs.push("--launch-info", JSON.stringify(launchInfo));

  const mcpConfig = JSON.stringify({ mcpServers });

  // The base aiui plugin and the frontend-design principles always load. The
  // session-browser skill is an add-on for the Chrome DevTools MCP — etiquette
  // for driving the *shared* browser — so the session is lightened by leaving
  // it out whenever that MCP isn't attached.
  const plugins = [join(pluginsRoot, "aiui"), join(pluginsRoot, "frontend-design")];
  if (chromeInfo.enabled) {
    plugins.push(join(pluginsRoot, "session-browser"));
  }

  // We don't add `--chrome` or `--no-chrome`: whether to use Claude's own
  // browser integration is the user's call, forwarded via passthrough (e.g.
  // `aiui claude --chrome`) — it is independent of the Chrome DevTools MCP
  // above. Automated/CI contexts pass `--no-chrome` themselves (see the e2e
  // test harness) to skip the browser-detection startup prompt.
  // Extra argv the user wants on every launch, forwarded verbatim ahead of the
  // machinery below (`claude.args`). This is where --dangerously-skip-permissions
  // lives now — opt in with `aiui config set-dsp`; nothing adds it by default, so
  // out of the box Claude Code's own permission prompts stay in charge
  // (docs/guide/warning).
  const configArgs = config.claude?.args ?? [];
  const args = [
    ...configArgs,
    "--mcp-config",
    mcpConfig,
    ...plugins.flatMap((dir) => ["--plugin-dir", dir]),
    // Custom channels are a research preview and not on the approved allowlist,
    // so opt this session into loading ours as a development channel.
    "--dangerously-load-development-channels",
    `server:${CHANNEL_SERVER_ID}`,
  ];

  // Loading our development channel makes Claude show a one-key acknowledgement
  // prompt at startup. Whether aiui best-effort presses Enter on the user's
  // behalf is their saved first-run choice (claude.enterNudge; see
  // nudgeChannelAck for the mechanism). Never outside an interactive TTY — the
  // prompt only appears in the interactive TUI, and the e2e harness drives its
  // own keypresses over tmux. The master switch (currently off) lives with the
  // mechanism — see ENTER_NUDGE_ENABLED in util/enter-nudge.ts.
  if (ENTER_NUDGE_ENABLED && interactive && (config.claude?.enterNudge ?? true)) {
    nudgeChannelAck();
  }

  // Hand the terminal over to Claude. stdio:"inherit" so the session owns the
  // terminal (and, when spawned by the test harness, so Claude's stdio is the
  // harness's captured pipes). reject:false so an interrupted/non-zero Claude
  // exit becomes our exit code rather than a thrown error.
  const result = await execa("claude", [...args, ...passthrough], {
    stdio: "inherit",
    reject: false,
  });
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}

/** Check for `claude`; print the friendly install pointer when missing. */
function ensureClaudeOnPath(): boolean {
  if (commandExists("claude")) {
    return true;
  }
  printError(
    "`claude` was not found on your PATH",
    "Install Claude Code and make sure the `claude` command is available, then try again.",
  );
  process.exitCode = 1;
  return false;
}

/** Run claude with the args verbatim (the --help/--version forward). */
async function forwardToClaude(args: string[]): Promise<void> {
  if (!ensureClaudeOnPath()) {
    return;
  }
  const result = await execa("claude", args, { stdio: "inherit", reject: false });
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}

/** The aiui half of `aiui claude --help` (claude's own --help follows it). */
function printClaudeWrapperHelp(): void {
  console.log(`aiui claude — launch Claude Code wired with the aiui channel, plugin, and browser MCP

aiui's own flags (everything else forwards to claude verbatim):
  --aiui-tag <tag>               tag the channel session (e.g. for \`quick --tag\`)
  --aiui-chrome                  force the Chrome DevTools MCP on (even under CI)
  --aiui-no-chrome               launch without the Chrome DevTools MCP
  --aiui-chrome-profile <name>   browser profile at .aiui-cache/chrome/<name>
  --aiui-chrome-data-dir <path>  explicit browser user data dir
  --aiui-browser-url <url>       attach to a browser at this DevTools endpoint
                                 (e.g. a tunnel from \`aiui browser --tunnel\`)
  --aiui-bind <loopback|host>    where the channel's web server binds: loopback
                                 (this machine only, the default) or host (your
                                 whole network can reach the session's web
                                 surface — the iPad pencil page included;
                                 trusted networks only)

Every channel hosts the same session sidecars — the intent panel at /intent/,
the remote bar, the remote pencil, and the console — reachable per --aiui-bind.
Durable settings live in config.json (project .aiui-cache/ + user cache) — see the
Configuration guide. What follows is claude's own --help:
`);
}

/**
 * Assemble the chrome-devtools MCP entry for this launch.
 *
 * The decision ladder:
 *  1. `chrome.browserUrl` configured → attach verbatim. The browser lives
 *     elsewhere (typically another machine, tunneled — see docs/guide/remote);
 *     nothing local is managed: no CfT sync, no profile, no extension.
 *  2. Attach mode with a session browser already running on this profile →
 *     attach to it (works non-interactively too; discovery is read-only).
 *  3. Attach mode, interactive → start the session browser now (the managed
 *     browser, intent client extension loaded, visible from t0) and attach. On failure, warn
 *     and fall through.
 *  4. Otherwise — `mode: "launch"`, a non-interactive session with nothing
 *     running, or a failed start — classic launch mode: chrome-devtools-mcp
 *     starts its own private browser lazily, on the agent's first tool call.
 */
async function chromeServerEntry(
  aiuiArgs: AiuiArgs,
  chromeCfg: NonNullable<AiuiConfig["chrome"]>,
  interactive: boolean,
): Promise<{ entry: { command: string; args: string[] }; info: ChromeDevtoolsInfo }> {
  if (chromeCfg.browserUrl) {
    return {
      entry: chromeMcpAttachServer(chromeCfg.browserUrl),
      info: { enabled: true, connection: "attach", browserUrl: chromeCfg.browserUrl },
    };
  }

  const cfg = chromeCfg;
  let settings = resolveChromeSettings(aiuiArgs, cfg);

  if (settings.mode === "attach") {
    const running = await discoverSessionBrowser(settings.userDataDir);
    if (running) {
      // The running browser may predate this checkout's native host (or the
      // feature): keep the profile's NM manifest current even when attaching.
      ensureProfileNativeHost(
        settings.userDataDir,
        findIntentClientExtension().state === "ready",
        printWarning,
      );
      return {
        entry: chromeMcpAttachServer(running.browserUrl),
        info: {
          enabled: true,
          connection: "attach",
          browserUrl: running.browserUrl,
          userDataDir: settings.userDataDir,
        },
      };
    }
  }

  // From here a browser will be launched one way or the other — pick the
  // binary. Unless config names a browser explicitly, prefer the managed
  // browser (Chromium by default, or Chrome for Testing per chrome.managed;
  // offer to install/update it interactively — see syncManagedBrowser). Patch
  // the resolved executable onto `settings` WITHOUT re-deriving userDataDir:
  // the profile is partitioned by the managed *flavor*, not by this path, and
  // re-resolving would misread the injected binary as an explicit
  // executablePath (a `custom-*` variant) and move the profile.
  if (!cfg.executablePath && !cfg.channel) {
    const exe = await syncManagedBrowser({
      flavor: resolveManagedFlavor(cfg),
      mode: resolveManageMode(cfg),
      interactive,
    });
    if (exe) {
      settings = { ...settings, executablePath: exe };
    }
  }
  mkdirSync(settings.userDataDir, { recursive: true });
  // Launches auto-load ONLY the intent client's extension (the historical
  // overlay/extension surfaces are deleted; the trace debugger lives INSIDE
  // the intent panel).
  const intent = findIntentClientExtension();
  const extensionDirs = intent.state === "ready" ? [intent.dir] : [];
  // The extension's channel discovery runs over native messaging, and CfT
  // looks the manifest up in the profile itself — keep it planted there.
  ensureProfileNativeHost(settings.userDataDir, intent.state === "ready", printWarning);
  if (interactive) {
    maybeExtensionAutoloadHint(settings, extensionDirs);
    warnIntentClientState(intent);
  }
  const browserInfo = {
    userDataDir: settings.userDataDir,
    executablePath: settings.executablePath,
    channel: settings.channel,
    headless: settings.headless,
    extensionDirs,
  };

  if (settings.mode === "attach" && interactive) {
    try {
      const session = await launchSessionBrowser({
        binary: sessionBrowserBinary(settings),
        userDataDir: settings.userDataDir,
        debugPort: settings.debugPort,
        extensionDirs,
        headless: settings.headless,
      });
      return {
        entry: chromeMcpAttachServer(session.browserUrl),
        info: {
          enabled: true,
          connection: "attach",
          browserUrl: session.browserUrl,
          ...browserInfo,
        },
      };
    } catch (error) {
      printWarning(
        "couldn't start the session browser — falling back to a browser private to the MCP",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return {
    entry: chromeMcpServer(settings, extensionDirs),
    info: { enabled: true, connection: "launch", ...browserInfo },
  };
}

/**
 * Whether this invocation will bring up Claude's interactive TUI — the only
 * context where the channel acknowledgement prompt appears. Requires a real
 * terminal on both ends and no print-mode flag.
 */
export function isInteractiveSession(passthrough: string[]): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  return !passthrough.some((arg) => arg === "-p" || arg === "--print");
}
