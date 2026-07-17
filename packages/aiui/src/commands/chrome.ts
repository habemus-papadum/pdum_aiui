/**
 * `aiui chrome <action>` — manage the agent's browser.
 *
 *   install | update   bring the managed Chrome for Testing to latest stable
 *   status             what would launch here, and is the intent client loadable
 *
 * `install` and `update` are the same operation (idempotent "ensure latest");
 * both names exist because both questions get asked. `status` is the
 * diagnostic: it reports per the *current directory's* merged config, so run
 * it from the project you're wondering about.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { discoverSessionBrowser } from "@habemus-papadum/aiui-util";
import { ensureLatestCft, installedCft, latestStableCft } from "../util/cft";
import {
  chromeDevtoolsEnabled,
  chromeUserDataDir,
  findIntentClientExtension,
  resolveChromeSettings,
} from "../util/chrome";
import { loadAiuiConfig } from "../util/config";
import { printError } from "../util/ui";

export async function runChrome(args: string[]): Promise<void> {
  const [action] = args;
  switch (action) {
    case "install":
    case "update":
      await ensureLatestCft((line) => console.log(line));
      return;
    case "status":
      await printStatus();
      return;
    default:
      printError(
        action ? `unknown aiui chrome action: ${action}` : "aiui chrome needs an action",
        "Usage: aiui chrome <install | update | status>",
      );
      process.exitCode = 1;
      return;
  }
}

/** The human-facing dump of every browser decision this directory would get. */
async function printStatus(): Promise<void> {
  const config = loadAiuiConfig();
  const chromeCfg = config.chrome ?? {};
  const flags = { chrome: false, noChrome: false };

  const cft = await installedCft();
  const latest = await latestStableCft();

  console.log("Chrome for Testing (managed):");
  if (cft) {
    const freshness =
      latest === undefined
        ? "(latest stable unknown — offline?)"
        : latest === cft.buildId
          ? "(latest stable)"
          : `(latest stable is ${latest} — run \`aiui chrome update\`)`;
    console.log(`  installed ${cft.buildId} ${freshness}`);
    console.log(`  ${cft.executablePath}`);
  } else {
    console.log("  not installed — `aiui chrome install` (recommended; auto-loads the panel)");
  }
  console.log(`  startup checks (chrome.forTesting): ${chromeCfg.forTesting ?? "prompt"}`);

  console.log("\nThis directory would launch:");
  if (!chromeDevtoolsEnabled(flags, chromeCfg)) {
    console.log("  nothing — the Chrome DevTools MCP is disabled here");
    return;
  }
  if (chromeCfg.browserUrl) {
    console.log(`  connection: attach to ${chromeCfg.browserUrl} (chrome.browserUrl)`);
    console.log("  the browser is managed elsewhere — nothing launches on this machine");
    return;
  }
  const effective = { ...chromeCfg };
  if (!effective.executablePath && !effective.channel && cft) {
    effective.executablePath = cft.executablePath;
  }
  const settings = resolveChromeSettings({}, effective);
  const running = await discoverSessionBrowser(settings.userDataDir);
  const connection =
    settings.mode === "attach"
      ? running
        ? `attach to the running session browser at ${running.browserUrl}`
        : "attach — a session browser starts with the next interactive launch (or `aiui browser`)"
      : "launch — chrome-devtools-mcp starts a private browser on the agent's first tool use";
  console.log(`  connection: ${connection}`);
  const browser = settings.executablePath
    ? settings.executablePath === cft?.executablePath
      ? `Chrome for Testing ${cft.buildId}`
      : settings.executablePath
    : settings.channel
      ? `installed Chrome (${settings.channel} channel)`
      : "installed Chrome (stable)";
  console.log(`  browser: ${browser}${settings.headless ? " — headless" : ""}`);
  console.log(`  user data dir: ${settings.userDataDir}`);
  const profilesDir = join(chromeUserDataDir({}, process.cwd()), "..");
  if (existsSync(profilesDir)) {
    const profiles = readdirSync(profilesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    if (profiles.length) {
      console.log(`  profiles here: ${profiles.join(", ")}`);
    }
  }

  console.log("\naiui intent client (the extension launches auto-load):");
  const client = findIntentClientExtension();
  switch (client.state) {
    case "absent":
      console.log("  not available in this install (aiui-intent-client is not resolvable)");
      break;
    case "unbuilt":
      console.log(
        `  no MV3 bundle yet (${client.root})\n` +
          "  build it:      pnpm -C packages/aiui-intent-client build:ext\n" +
          "  build + load into the running browser:  pnpm -C packages/aiui-intent-client ext",
      );
      break;
    case "ready":
      console.log(`  ${client.dir}`);
      printAutoloadability(settings.executablePath);
      break;
  }
}

/** Whether the chosen browser will honor `--load-extension` for this dir. */
function printAutoloadability(executablePath: string | undefined): void {
  if (executablePath) {
    console.log("  auto-loads via --load-extension (honored by Chrome for Testing/Chromium)");
  } else {
    console.log("  can NOT auto-load into branded Chrome ≥ 137 — load it unpacked once");
    console.log(
      "  (chrome://extensions → Developer mode → Load unpacked), or `aiui chrome install`",
    );
  }
}
