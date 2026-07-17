/**
 * `aiui chrome <action>` — manage the agent's browser.
 *
 *   install | update [flavor]   bring a managed browser to latest
 *   status                      what would launch here, and is the intent
 *                               client loadable
 *
 * `install` and `update` are the same operation (idempotent "ensure latest");
 * both names exist because both questions get asked. Without a flavor they act
 * on the configured `chrome.managed` (Chromium by default); pass `chromium` or
 * `chrome-for-testing` to target the other explicitly. `status` is the
 * diagnostic: it reports per the *current directory's* merged config, so run it
 * from the project you're wondering about.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { discoverSessionBrowser } from "@habemus-papadum/aiui-util";
import {
  chromeDevtoolsEnabled,
  findIntentClientExtension,
  resolveChromeSettings,
} from "../util/chrome";
import {
  loadAiuiConfig,
  MANAGED_FLAVORS,
  type ManagedFlavor,
  resolveManagedFlavor,
  resolveManageMode,
} from "../util/config";
import {
  ensureLatestManaged,
  flavorSpec,
  installedManaged,
  latestManaged,
} from "../util/managed-browser";
import { printError } from "../util/ui";

export async function runChrome(args: string[]): Promise<void> {
  const [action, flavorArg] = args;
  switch (action) {
    case "install":
    case "update": {
      const resolved = resolveFlavorArg(flavorArg);
      if ("error" in resolved) {
        printError(resolved.error, "Usage: aiui chrome install [chromium | chrome-for-testing]");
        process.exitCode = 1;
        return;
      }
      await ensureLatestManaged(resolved.flavor, (line) => console.log(line));
      return;
    }
    case "status":
      await printStatus();
      return;
    default:
      printError(
        action ? `unknown aiui chrome action: ${action}` : "aiui chrome needs an action",
        "Usage: aiui chrome <install | update [flavor] | status>",
      );
      process.exitCode = 1;
      return;
  }
}

/**
 * Which flavor an `install`/`update` targets: the argument if given (with `cft`
 * as a shorthand), else the configured `chrome.managed`.
 */
function resolveFlavorArg(arg: string | undefined): { flavor: ManagedFlavor } | { error: string } {
  if (arg === undefined) {
    return { flavor: resolveManagedFlavor(loadAiuiConfig().chrome) };
  }
  const aliases: Record<string, ManagedFlavor> = {
    chromium: "chromium",
    "chrome-for-testing": "chrome-for-testing",
    cft: "chrome-for-testing",
  };
  const flavor = aliases[arg];
  return flavor
    ? { flavor }
    : { error: `unknown browser "${arg}" — use chromium or chrome-for-testing` };
}

/** The human-facing dump of every browser decision this directory would get. */
async function printStatus(): Promise<void> {
  const config = loadAiuiConfig();
  const chromeCfg = config.chrome ?? {};
  const flags = { chrome: false, noChrome: false };
  const preferred = resolveManagedFlavor(chromeCfg);

  console.log("Managed browsers:");
  console.log(`  preferred (chrome.managed): ${flavorSpec(preferred).displayName}`);
  for (const flavor of MANAGED_FLAVORS) {
    const spec = flavorSpec(flavor);
    const tag = flavor === preferred ? " *preferred*" : "";
    const install = await installedManaged(flavor);
    if (install) {
      const latest = await latestManaged(flavor);
      const freshness =
        latest === undefined
          ? "(latest unknown — offline?)"
          : latest === install.buildId
            ? "(latest)"
            : `(latest is ${latest} — \`aiui chrome update ${flavor}\`)`;
      console.log(`  ${spec.displayName}${tag}: ${install.buildId} ${freshness}`);
      console.log(`    ${install.executablePath}`);
    } else {
      const cmd = flavor === preferred ? "aiui chrome install" : `aiui chrome install ${flavor}`;
      console.log(`  ${spec.displayName}${tag}: not installed — \`${cmd}\``);
    }
  }
  console.log(`  startup checks (chrome.manage): ${resolveManageMode(chromeCfg)}`);

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
  // Settings come from the config as written, so the profile variant reflects
  // the *declared* browser intent — never a managed binary path we'd inject
  // (that would misread as a `custom-*` variant; see chromeVariant).
  const settings = resolveChromeSettings({}, chromeCfg);
  const preferredInstall =
    settings.executablePath || settings.channel ? undefined : await installedManaged(preferred);
  const running = await discoverSessionBrowser(settings.userDataDir);
  const connection =
    settings.mode === "attach"
      ? running
        ? `attach to the running session browser at ${running.browserUrl}`
        : "attach — a session browser starts with the next interactive launch (or `aiui browser`)"
      : "launch — chrome-devtools-mcp starts a private browser on the agent's first tool use";
  console.log(`  connection: ${connection}`);
  const browser = settings.executablePath
    ? settings.executablePath
    : settings.channel
      ? `installed Chrome (${settings.channel} channel)`
      : preferredInstall
        ? `${flavorSpec(preferred).displayName} ${preferredInstall.buildId} (managed)`
        : `${flavorSpec(preferred).displayName} (managed — not yet installed)`;
  console.log(`  browser: ${browser}${settings.headless ? " — headless" : ""}`);
  console.log(`  profile variant: ${settings.variant}`);
  console.log(`  user data dir: ${settings.userDataDir}`);
  // Only a branded `channel` launch fails to honor --load-extension; the
  // managed flavors and an explicit executablePath all honor it.
  const honorsLoadExtension = !settings.channel;
  const variantDir = dirname(settings.userDataDir);
  if (existsSync(variantDir)) {
    const profiles = readdirSync(variantDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    if (profiles.length) {
      console.log(`  profiles here (${settings.variant}): ${profiles.join(", ")}`);
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
      printAutoloadability(honorsLoadExtension);
      break;
  }
}

/** Whether the chosen browser will honor `--load-extension` for this dir. */
function printAutoloadability(honorsLoadExtension: boolean): void {
  if (honorsLoadExtension) {
    console.log("  auto-loads via --load-extension (honored by Chromium/Chrome for Testing)");
  } else {
    console.log("  can NOT auto-load into branded Chrome ≥ 137 — load it unpacked once");
    console.log(
      "  (chrome://extensions → Developer mode → Load unpacked), or `aiui chrome install`",
    );
  }
}
