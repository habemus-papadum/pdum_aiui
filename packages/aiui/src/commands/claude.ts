import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChromeDevtoolsInfo, LaunchInfo } from "@habemus-papadum/aiui-claude-channel";
import {
  discoverSessionBrowser,
  isCi,
  probeVault,
  resolveVendorKeys,
} from "@habemus-papadum/aiui-util";
import { execa } from "execa";
import { type AiuiArgs, infoFlag, splitAiuiArgs } from "../util/aiui-args";
import { channelLaunchFlags, resolveChannelLaunch } from "../util/channel-launch";
import {
  CHROME_SERVER_ID,
  chromeMcpAttachServer,
  chromeMcpServer,
  findIntentClientExtension,
  maybeExtensionAutoloadHint,
  resolveChromeSettings,
  sessionBrowserEnabled,
  warnIntentClientState,
} from "../util/chrome";
import { type AiuiConfig, type ChromeChannel, loadAiuiConfig } from "../util/config";
import { ENTER_NUDGE_ENABLED, nudgeChannelAck } from "../util/enter-nudge";
import { ensureLaunchChoices } from "../util/first-run";
import { ensureKeyDecisions, keysMode } from "../util/keys-interview";
import { ensureProfileMarker } from "../util/profile";
import { packageRoot, resolvePackageCli } from "../util/resolve-cli";
import { resolveProfileBinary, startSessionBrowser } from "../util/session-browser";
import { printError, printWarning } from "../util/ui";
import { preflightVendorKeys, reportVendorKeyPreflight } from "../util/vendor-key-preflight";
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
  // A corrupt intent-client bundle fails the launch outright. `unbuilt` (the
  // fresh-checkout state) stays a warning further down — there's nothing wrong,
  // just a step not taken yet — but corrupt means a build half-happened (the
  // empty-chunk watch rebuild; see chrome.ts's probeIntentClientBundle) and
  // every session started over it gets a silently blank side panel.
  const intentPreflight = findIntentClientExtension();
  if (intentPreflight.state === "corrupt") {
    printError(
      "the aiui intent client's MV3 bundle is corrupt — refusing to launch",
      `${intentPreflight.dir}\n  ${intentPreflight.detail}\n` +
        "Rebuild it and relaunch:  pnpm -C packages/aiui-intent-client build:ext",
    );
    process.exitCode = 1;
    return;
  }

  // `claude` is the binary this command wraps — the most fundamental
  // precondition of all. Check it FIRST, before the interactive key interview,
  // the vault probe, or any network key verification: a user who hasn't
  // installed Claude Code can't launch a session regardless of their keys, so
  // "install claude" is the one message worth showing them.
  if (!ensureClaudeOnPath()) {
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
    // The vendor-key gap-fill (util/keys-interview.ts): any provider with NO
    // recorded decision gets one question — paste the key (into the OS vault)
    // or skip the provider. A source checkout with the key already in the
    // environment skips the question silently and writes nothing to the vault
    // (env → vault is `aiui keys set`, never a launch side effect). Decided
    // providers are never re-asked; `aiui keys interview` is the full revisit.
    config = await ensureKeyDecisions(config);
  }

  // Installed mode has exactly ONE key source — the OS vault — so if its CLI
  // isn't even on PATH, every key resolves to "missing" and the session would
  // boot quietly keyless (no transcription, no Live). That is a structural
  // precondition, not a per-key degradation to warn past: fail loudly now, with
  // the platform's install hint, rather than launch broken. (Source mode still
  // has the environment/.env to fall back on, so a missing vault only degrades
  // there — the channel re-resolves either way.)
  const mode = keysMode();
  if (mode === "installed") {
    const vault = await probeVault();
    if (!vault.available) {
      printError(
        "No OS key vault available",
        `aiui reads your vendor API keys from the OS key vault, but ${vault.bin ? `\`${vault.bin}\`` : "no vault backend"} is unavailable. ` +
          `Without it the session has no keys and would boot broken.\n\n${vault.help}`,
      );
      process.exitCode = 1;
      return;
    }
  }

  // Resolve the three vendor keys the way the channel itself will at boot
  // (aiui-util/vendor-keys.ts): a source checkout honors the environment/.env
  // first, an installed aiui reads the OS vault only, a skip stays keyless by
  // choice (AIUI_NO_SOURCE_MODE forces the installed path in every process).
  // Values are used ONLY to preflight; the channel re-resolves vault-side in
  // its own process — keys never ride through claude's env.
  const resolvedKeys = await resolveVendorKeys({
    mode,
    onWarn: (message) => printWarning(message),
  });

  // Round two of the key story: VALIDITY only (util/vendor-key-preflight).
  // Discovery — mode, skips, values — was round one's job above; here each
  // FOUND key is checked against its vendor (interactive launches only;
  // CI/non-interactive never touch the network and report "unverified"). A
  // definitively rejected key fails the launch — it was placed on purpose, so
  // rejection means the session would boot quietly broken (transcription
  // 401s, a Gemini Live socket that closes on open) with the fix known NOW.
  // Missing keys stay degradation warnings, and an unconfirmable check never
  // condemns. Only statuses (never keys) thread into launch-info below.
  const keyStatuses = await preflightVendorKeys(resolvedKeys, { verify: interactive });
  if (interactive) {
    const { fatal } = reportVendorKeyPreflight(resolvedKeys, keyStatuses);
    if (fatal) {
      process.exitCode = 1;
      return;
    }
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

  // By default the session also gets the shared session browser + its Chrome
  // DevTools MCP — off under CI, `--aiui-no-session-browser`, or
  // `chrome.enabled: false`. In the default "attach" mode the MCP shares a
  // user-visible session browser (see aiui-util's browser module);
  // "launch" mode keeps the browser private to the MCP and lazily started.
  let chromeInfo: ChromeDevtoolsInfo = { enabled: false };
  if (sessionBrowserEnabled(aiuiArgs)) {
    const chrome = await chromeServerEntry(aiuiArgs, { ...config.chrome }, interactive);
    mcpServers[CHROME_SERVER_ID] = chrome.entry;
    chromeInfo = chrome.info;
  }
  // Tell the channel server how this session was assembled. It surfaces this
  // at /debug/api/info, and the DevTools panel's Server tab renders it — the
  // first place to look when browser/MCP connectivity misbehaves.
  const launchInfo: LaunchInfo = {
    launcher: "aiui claude",
    chromeDevtools: chromeInfo,
    openaiKey: keyStatuses.openai,
    geminiKey: keyStatuses.gemini,
    elevenlabsKey: keyStatuses.elevenlabs,
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
  // lives now — opt in with `aiui config yolo`; nothing adds it by default, so
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
  --aiui-session-browser         force the session browser + DevTools MCP on (even under CI)
  --aiui-no-session-browser      launch with no session browser (and no DevTools MCP)
  --aiui-profile <name>          browser profile (~/.cache/aiui/userdata/<name>)
  --aiui-chrome-data-dir <path>  explicit browser user data dir
  --aiui-browser-url <url>       attach to a browser at this DevTools endpoint
                                 (e.g. the tunnel from \`aiui remote\`)
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
 *  1. `--aiui-browser-url` → attach verbatim. The browser lives elsewhere
 *     (typically another machine — `aiui remote` prints this flag); nothing
 *     local is managed: no sync, no profile, no extension.
 *  2. A session browser already running on this profile → attach to it (works
 *     non-interactively too; discovery is read-only).
 *  3. Interactive → start the session browser now (the shared pipeline:
 *     profile marker, managed sync, intent extension) and attach. On failure,
 *     warn and fall through.
 *  4. Otherwise — a non-interactive session with nothing running, or a failed
 *     start — launch mode: chrome-devtools-mcp starts its own private browser
 *     lazily, on the agent's first tool call, with this profile's settings.
 */
async function chromeServerEntry(
  aiuiArgs: AiuiArgs,
  chromeCfg: NonNullable<AiuiConfig["chrome"]>,
  interactive: boolean,
): Promise<{ entry: { command: string; args: string[] }; info: ChromeDevtoolsInfo }> {
  if (aiuiArgs.browserUrl) {
    return {
      entry: chromeMcpAttachServer(aiuiArgs.browserUrl),
      info: { enabled: true, connection: "attach", browserUrl: aiuiArgs.browserUrl },
    };
  }

  const cfg = chromeCfg;
  const probe = resolveChromeSettings(aiuiArgs, cfg);
  const running = await discoverSessionBrowser(probe.userDataDir);
  if (running) {
    // The running browser may predate this checkout's native host (or the
    // feature): keep the profile's NM manifest current even when attaching.
    ensureProfileNativeHost(
      probe.userDataDir,
      findIntentClientExtension().state === "ready",
      printWarning,
    );
    return {
      entry: chromeMcpAttachServer(running.browserUrl),
      info: {
        enabled: true,
        connection: "attach",
        browserUrl: running.browserUrl,
        userDataDir: probe.userDataDir,
      },
    };
  }
  if (interactive) {
    // Start the session browser now — the SHARED pipeline (profile marker,
    // managed-browser sync, intent extension, profile NM host) that
    // `open`/`remote` use; only the MCP-entry shaping is ours. The MCP attaches
    // to the browser's discovered debug endpoint. The channel opens its own
    // dashboard as a tab once it boots (see the channel's mcp command).
    try {
      const { session, settings } = await startSessionBrowser({
        flags: aiuiArgs,
        config: cfg,
        interactive: true,
      });
      return {
        entry: chromeMcpAttachServer(session.browserUrl),
        info: {
          enabled: true,
          connection: "attach",
          browserUrl: session.browserUrl,
          userDataDir: settings.userDataDir,
          headless: settings.headless,
        },
      };
    } catch (error) {
      printWarning(
        "couldn't start the session browser — falling back to a browser private to the MCP",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Launch mode (the fallback): chrome-devtools-mcp starts its own private
  // browser lazily, on the agent's first tool call — prep the launch inputs
  // from the profile's marker (silently created with the defaults when the
  // profile is new; non-interactive, so no interview).
  const settings = resolveChromeSettings(aiuiArgs, cfg);
  const marker =
    settings.browser ??
    (await ensureProfileMarker(settings.userDataDir, { interactive: false })).browser;
  let launch: { executablePath?: string; channel?: ChromeChannel } = {};
  try {
    launch = await resolveProfileBinary(marker, cfg, interactive);
  } catch (error) {
    // Managed browser not installed and nobody to ask — let the MCP fall back
    // to whatever Chrome it can find, but say why.
    printWarning(
      "the profile's managed browser is not installed — the MCP will use a system Chrome",
      error instanceof Error ? error.message : String(error),
    );
  }
  mkdirSync(settings.userDataDir, { recursive: true });
  // Launches auto-load ONLY the intent client's extension.
  const intent = findIntentClientExtension();
  const extensionDirs = intent.state === "ready" ? [intent.dir] : [];
  ensureProfileNativeHost(settings.userDataDir, intent.state === "ready", printWarning);
  if (interactive) {
    maybeExtensionAutoloadHint(settings, extensionDirs);
    warnIntentClientState(intent);
  }
  const mcpLaunch = {
    userDataDir: settings.userDataDir,
    ...launch,
    headless: settings.headless,
  };
  return {
    entry: chromeMcpServer(mcpLaunch, extensionDirs),
    info: { enabled: true, connection: "launch", ...mcpLaunch, extensionDirs },
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
