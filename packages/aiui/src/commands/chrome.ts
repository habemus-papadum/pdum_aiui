/**
 * `aiui chrome <action>` — manage the managed browser BINARIES.
 *
 *   install | update [flavor]   bring a managed browser to latest
 *   status                      what's installed, and what the default
 *                               profile would launch
 *
 * `install` and `update` are the same operation (idempotent "ensure latest");
 * both names exist because both questions get asked. Without a flavor they act
 * on the default (Chromium); pass `chromium` or `chrome-for-testing` to target
 * the other explicitly. Which browser a LAUNCH uses is the profile's business
 * (`aiui profile`, docs/proposals/browser-profiles.md) — profiles reference
 * the binaries this command manages.
 */
import { existsSync, readdirSync } from "node:fs";
import { discoverSessionBrowser } from "@habemus-papadum/aiui-util";
import {
  chromeDevtoolsEnabled,
  findIntentClientExtension,
  resolveChromeSettings,
} from "../util/chrome";
import {
  DEFAULT_MANAGED_FLAVOR,
  loadAiuiConfig,
  MANAGED_FLAVORS,
  type ManagedFlavor,
  resolveManageMode,
} from "../util/config";
import {
  ensureLatestManaged,
  flavorSpec,
  installedManaged,
  latestManaged,
} from "../util/managed-browser";
import { profileBrowserLabel, profilesRoot } from "../util/profile";
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

/** Which flavor an `install`/`update` targets: the argument (with `cft` as a
 * shorthand), else the default (Chromium). */
function resolveFlavorArg(arg: string | undefined): { flavor: ManagedFlavor } | { error: string } {
  if (arg === undefined) {
    return { flavor: DEFAULT_MANAGED_FLAVOR };
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

/** The human-facing dump: installed binaries + what the default profile does. */
async function printStatus(): Promise<void> {
  const config = loadAiuiConfig();
  const chromeCfg = config.chrome ?? {};
  const flags = { chrome: false, noChrome: false };

  console.log("Managed browsers:");
  for (const flavor of MANAGED_FLAVORS) {
    const spec = flavorSpec(flavor);
    const tag = flavor === DEFAULT_MANAGED_FLAVOR ? " *default*" : "";
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
      const cmd =
        flavor === DEFAULT_MANAGED_FLAVOR ? "aiui chrome install" : `aiui chrome install ${flavor}`;
      console.log(`  ${spec.displayName}${tag}: not installed — \`${cmd}\``);
    }
  }
  console.log(`  startup checks (chrome.manage): ${resolveManageMode(chromeCfg)}`);

  console.log("\nThe default profile:");
  if (!chromeDevtoolsEnabled(flags)) {
    console.log("  the Chrome DevTools MCP is disabled here (CI, or --aiui-no-chrome)");
  }
  const settings = resolveChromeSettings({}, chromeCfg);
  console.log(`  user data dir: ${settings.userDataDir}`);
  if (settings.browser) {
    console.log(`  browser (from the profile marker): ${profileBrowserLabel(settings.browser)}`);
  } else {
    console.log("  no profile marker yet — created on the first launch (or `aiui profile new`)");
  }
  const running = await discoverSessionBrowser(settings.userDataDir);
  console.log(
    running
      ? `  running: yes — ${running.browserUrl}`
      : "  running: no — starts with the next interactive launch (or `aiui open <url>`)",
  );

  const root = profilesRoot({ create: false });
  if (existsSync(root)) {
    const profiles = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    if (profiles.length) {
      console.log(`  profiles: ${profiles.join(", ")} (\`aiui profile list\` for detail)`);
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
    case "ready": {
      console.log(`  ${client.dir}`);
      // Only a branded `channel` marker fails to honor --load-extension; the
      // managed flavors and explicit binaries all honor it.
      const honors = !(settings.browser && "channel" in settings.browser);
      if (honors) {
        console.log("  auto-loads via --load-extension (honored by Chromium/Chrome for Testing)");
      } else {
        console.log("  can NOT auto-load into branded Chrome ≥ 137 — load it unpacked once");
        console.log(
          "  (chrome://extensions → Developer mode → Load unpacked), or `aiui chrome install`",
        );
      }
      break;
    }
  }
}
