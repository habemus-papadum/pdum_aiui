/**
 * The command-agnostic session-browser pipeline — settings → find-or-start →
 * a running browser with the intent client loaded and the profile's
 * native-messaging manifest planted. Hoisted out of `commands/browser.ts`
 * (docs/proposals/aiui-registry.md §5) so `aiui browser`, `aiui remote`, and
 * `aiui vite`'s sidecar all launch identically instead of re-deriving the
 * sequence; `aiui open` and `aiui claude`'s chromeServerEntry follow in M6.
 *
 * Identity is the profile's user data dir, discovered via Chrome's own
 * `DevToolsActivePort` file — the same way `aiui claude` attaches.
 */
import { join } from "node:path";
import {
  cacheDir,
  decideBrowserAction,
  discoverSessionBrowser,
  launchSessionBrowser,
  openInSessionBrowser,
  type SessionBrowser,
  sessionBrowserBinary,
} from "@habemus-papadum/aiui-util";
import chalk from "chalk";
import { ensureProfileNativeHost } from "../commands/extension";
import type { AiuiArgs } from "./aiui-args";
import {
  type ChromeSettings,
  findIntentClientExtension,
  maybeExtensionAutoloadHint,
  resolveChromeSettings,
  warnIntentClientState,
} from "./chrome";
import { type AiuiConfig, loadAiuiConfig, resolveManagedFlavor, resolveManageMode } from "./config";
import { syncManagedBrowser } from "./managed-browser";
import { printNote, printWarning } from "./ui";

type ChromeConfig = NonNullable<AiuiConfig["chrome"]>;

/** Options for {@link startSessionBrowser}. */
export interface StartSessionBrowserOptions {
  /** CLI identity flags (profile / data dir), reconciled against config. */
  flags?: Pick<AiuiArgs, "chromeProfile" | "chromeDataDir">;
  /** The `chrome` section of the loaded config. */
  config?: ChromeConfig;
  /**
   * Whether prompting is allowed. Interactive launches may offer to
   * install/update the managed browser and print the extension autoload hint;
   * non-interactive ones (CI, or a sidecar whose terminal belongs to another
   * process — `aiui vite`'s browser open) degrade to whatever browser is
   * already installed, silently.
   */
  interactive: boolean;
  /** Override the resolved DevTools debug port (`aiui browser --port`). */
  debugPort?: number;
  /** Launch headless regardless of config (`aiui browser --headless`). */
  headless?: boolean;
  /** Open this URL as the first tab instead of about:blank. */
  startUrl?: string;
}

/**
 * Launch the session browser — the shared "everything before the window
 * exists" sequence:
 *
 *  1. Resolve settings from flags + config.
 *  2. Prefer the managed browser (Chromium by default, or Chrome for Testing
 *     per chrome.managed) unless config names a browser explicitly (the sync
 *     may prompt to install/update — only when `interactive`; otherwise it just
 *     reports what's installed).
 *  3. Load the intent client's MV3 bundle if it has been built (dev checkouts
 *     only).
 *  4. Launch on the profile's user data dir and wait for the debug endpoint.
 *
 * Throws with a remediation-bearing message when no browser can be found or
 * the launch fails; callers decide whether that's fatal (`aiui browser`,
 * `aiui remote`) or merely a warning (`aiui vite`, where the dev server must
 * keep running).
 */
export async function startSessionBrowser(
  opts: StartSessionBrowserOptions,
): Promise<{ session: SessionBrowser; settings: ChromeSettings }> {
  const cfg = opts.config ?? {};
  const flags = opts.flags ?? {};
  let settings = resolveChromeSettings(flags, cfg);
  if (opts.debugPort !== undefined) {
    settings = { ...settings, debugPort: opts.debugPort };
  }

  if (!cfg.executablePath && !cfg.channel) {
    // Patch the resolved managed binary onto settings without re-deriving the
    // data dir — the profile is partitioned by the managed flavor, not this
    // path (twin of the comment in claude.ts).
    const exe = await syncManagedBrowser({
      flavor: resolveManagedFlavor(cfg),
      mode: resolveManageMode(cfg),
      interactive: opts.interactive,
    });
    if (exe) {
      settings = { ...settings, executablePath: exe };
    }
  }
  // Launches auto-load ONLY the intent client's extension — see the twin
  // comment in claude.ts.
  const intent = findIntentClientExtension();
  const extensionDirs = intent.state === "ready" ? [intent.dir] : [];
  // The extension's channel discovery runs over native messaging, and CfT
  // looks the manifest up in the profile itself — keep it planted there.
  ensureProfileNativeHost(settings.userDataDir, intent.state === "ready", printNote);
  if (opts.interactive) {
    maybeExtensionAutoloadHint(settings, extensionDirs);
    warnIntentClientState(intent);
  }

  let binary: string;
  try {
    binary = sessionBrowserBinary(settings);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        "Install the managed browser with `aiui chrome install`, or set chrome.executablePath.",
    );
  }
  const session = await launchSessionBrowser({
    binary,
    userDataDir: settings.userDataDir,
    debugPort: settings.debugPort,
    extensionDirs,
    headless: settings.headless || opts.headless,
    startUrl: opts.startUrl,
  });
  return { session, settings };
}

/**
 * Find the profile's running session browser, or start one. The find path
 * still refreshes the profile's NM manifest — the running browser may predate
 * this checkout's native host. `started` tells the caller which case it was
 * (their reporting differs); failures throw exactly like
 * {@link startSessionBrowser}.
 */
export async function findOrStartSessionBrowser(
  opts: StartSessionBrowserOptions,
): Promise<{ session: SessionBrowser; settings: ChromeSettings; started: boolean }> {
  let settings = resolveChromeSettings(opts.flags ?? {}, opts.config ?? {});
  if (opts.debugPort !== undefined) {
    settings = { ...settings, debugPort: opts.debugPort };
  }
  const existing = await discoverSessionBrowser(settings.userDataDir);
  if (existing) {
    ensureProfileNativeHost(
      settings.userDataDir,
      findIntentClientExtension().state === "ready",
      printNote,
    );
    return { session: existing, settings, started: false };
  }
  const started = await startSessionBrowser(opts);
  return { ...started, started: true };
}

/**
 * `~/.cache/aiui/browser-profiles/<key>` for a remote-anchored session browser
 * (`aiui remote`): usually no local checkout to be project-local to, so the
 * profile keys off the remote host in the user cache — reconnecting to the
 * same box reuses the same browser state. Path-only (no mkdir): the browser
 * launch creates it on first use.
 */
export function remoteProfileDir(target: string, profile?: string): string {
  const key = profile ?? sanitizeHostKey(target);
  return join(cacheDir("browser-profiles", { create: false }), key);
}

/** "user@dev.example.com" → "dev.example.com", made filesystem-safe. */
export function sanitizeHostKey(target: string): string {
  const host = target.includes("@") ? target.slice(target.indexOf("@") + 1) : target;
  const key = host.replace(/[^A-Za-z0-9._-]/g, "-");
  return key || "remote";
}

/**
 * Put a URL in front of the user in the *session browser* (the shared window
 * `aiui claude` attaches the agent to), never their default browser. A running
 * session browser gets a new tab; none running means launching one with the
 * URL as its first tab.
 *
 * Sidecar-safe: everything is caught, failures print a warning, and the
 * caller keeps running either way. Deliberately non-interactive — a sidecar's
 * terminal belongs to another process, so the managed-browser sync never
 * prompts here; it uses whatever browser is already available.
 */
export async function openAppInBrowser(url: string, aiuiArgs: AiuiArgs): Promise<void> {
  try {
    // `--aiui-browser-url` beats a configured chrome.browserUrl for this run,
    // the same precedence `aiui claude` gives it.
    const chromeCfg: ChromeConfig = {
      ...loadAiuiConfig().chrome,
      ...(aiuiArgs.browserUrl ? { browserUrl: aiuiArgs.browserUrl } : {}),
    };
    const action = decideBrowserAction(aiuiArgs, chromeCfg);
    if (action.kind === "skip") {
      return;
    }
    if (action.kind === "hint") {
      printNote(
        `detected a headless environment (${action.reason}) — not opening a browser`,
        `Assuming the server's port is already forwarded, open ${url} in the browser\n` +
          "on your local machine. (Pass --aiui-browser to open one here anyway.)",
      );
      return;
    }

    if (chromeCfg.browserUrl) {
      await openInSessionBrowser(chromeCfg.browserUrl, url);
      console.error(chalk.dim(`aiui: opened ${url} in the browser at ${chromeCfg.browserUrl}`));
      return;
    }
    const settings = resolveChromeSettings(aiuiArgs, chromeCfg);
    const running = await discoverSessionBrowser(settings.userDataDir);
    if (running) {
      await openInSessionBrowser(running.browserUrl, url);
      console.error(chalk.dim(`aiui: opened ${url} in the session browser`));
    } else {
      await startSessionBrowser({
        flags: aiuiArgs,
        config: chromeCfg,
        interactive: false,
        startUrl: url,
      });
      console.error(chalk.dim(`aiui: opened ${url} in a new session browser`));
    }
  } catch (error) {
    printWarning(
      "couldn't open the app in the session browser — the caller is unaffected",
      error instanceof Error ? error.message : String(error),
    );
  }
}
