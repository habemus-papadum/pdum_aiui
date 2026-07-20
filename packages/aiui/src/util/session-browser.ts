/**
 * The command-agnostic session-browser pipeline — settings → find-or-start →
 * a running browser with the intent client loaded and the profile's
 * native-messaging manifest planted. Shared by `aiui open`, `aiui remote`,
 * `aiui dashboard`, and `aiui claude`'s chromeServerEntry, so every command
 * launches identically instead of re-deriving the sequence.
 *
 * Identity is the PROFILE (util/profile.ts): its user-data dir names the
 * browser via the immutable marker, and Chrome's own `DevToolsActivePort`
 * file inside it is how a running instance is discovered — the same way
 * `aiui claude` attaches. All sessions share the "default" profile unless a
 * `--profile` says otherwise (docs/proposals/browser-profiles.md).
 */
import {
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
import { type AiuiConfig, type ChromeChannel, loadAiuiConfig, resolveManageMode } from "./config";
import { syncManagedBrowser } from "./managed-browser";
import { ensureProfileMarker, type ProfileBrowser } from "./profile";
import { printNote, printWarning } from "./ui";

type ChromeConfig = NonNullable<AiuiConfig["chrome"]>;

/** Options for {@link startSessionBrowser}. */
export interface StartSessionBrowserOptions {
  /** CLI identity flags (profile / data dir), reconciled against config. */
  flags?: Pick<AiuiArgs, "chromeProfile" | "chromeDataDir">;
  /** The `chrome` section of the loaded config. */
  config?: ChromeConfig;
  /**
   * Whether prompting is allowed. Interactive launches may run the
   * profile-creation interview and offer to install/update the managed
   * browser; non-interactive ones (CI, or a sidecar whose terminal belongs to
   * another process) take the silent defaults.
   */
  interactive: boolean;
  /** Launch headless regardless of config. */
  headless?: boolean;
  /** Open this URL as the first tab instead of about:blank. */
  startUrl?: string;
}

/**
 * The launch inputs a profile's marker names. A managed flavor goes through
 * {@link syncManagedBrowser} (which may prompt to install/update when
 * `interactive`, and reports the installed binary otherwise); a branded
 * channel or explicit path is used as-is. A managed flavor with nothing
 * installed and no way to ask throws with the remediation.
 */
export async function resolveProfileBinary(
  browser: ProfileBrowser,
  cfg: ChromeConfig,
  interactive: boolean,
): Promise<{ executablePath?: string; channel?: ChromeChannel }> {
  if ("executablePath" in browser) {
    return { executablePath: browser.executablePath };
  }
  if ("channel" in browser) {
    return { channel: browser.channel };
  }
  const exe = await syncManagedBrowser({
    flavor: browser.managed,
    mode: resolveManageMode(cfg),
    interactive,
  });
  if (!exe) {
    throw new Error(
      `this profile uses the managed ${browser.managed}, which is not installed.\n` +
        `Install it with \`aiui chrome install ${browser.managed}\` (or relaunch interactively).`,
    );
  }
  return { executablePath: exe };
}

/**
 * Launch the session browser — the shared "everything before the window
 * exists" sequence:
 *
 *  1. Resolve the profile (flags + config); ensure its marker exists (the
 *     profile-creation interview on an interactive first run, the silent
 *     Chromium default otherwise).
 *  2. Resolve the marker's browser to a binary (managed flavors may
 *     install/update via prompt — only when `interactive`).
 *  3. Load the intent client's MV3 bundle if it has been built, and plant the
 *     profile's native-messaging manifest.
 *  4. Launch on the profile's user data dir and wait for the debug endpoint.
 *
 * Throws with a remediation-bearing message when no browser can be found or
 * the launch fails; callers decide whether that's fatal (`aiui open`,
 * `aiui remote`) or merely a warning (a sidecar that must keep running).
 */
export async function startSessionBrowser(
  opts: StartSessionBrowserOptions,
): Promise<{ session: SessionBrowser; settings: ChromeSettings }> {
  const cfg = opts.config ?? {};
  const flags = opts.flags ?? {};
  let settings = resolveChromeSettings(flags, cfg);

  const marker =
    settings.browser ??
    (
      await ensureProfileMarker(settings.userDataDir, {
        interactive: opts.interactive,
        profileName: flags.chromeProfile ?? (flags.chromeDataDir ? undefined : "default"),
      })
    ).browser;
  settings = { ...settings, browser: marker };
  const binary = await resolveProfileBinary(marker, cfg, opts.interactive);

  // Launches auto-load ONLY the intent client's extension.
  const intent = findIntentClientExtension();
  const extensionDirs = intent.state === "ready" ? [intent.dir] : [];
  // The extension's channel discovery runs over native messaging, and the
  // managed browsers look the manifest up in the profile itself — keep it
  // planted there.
  ensureProfileNativeHost(settings.userDataDir, intent.state === "ready", printNote);
  if (opts.interactive) {
    maybeExtensionAutoloadHint(settings, extensionDirs);
    warnIntentClientState(intent);
  }

  const session = await launchSessionBrowser({
    binary: sessionBrowserBinary(binary),
    userDataDir: settings.userDataDir,
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
  const settings = resolveChromeSettings(opts.flags ?? {}, opts.config ?? {});
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

/** "user@dev.example.com" → "dev.example.com", made filesystem-safe (the
 * remote command's history files key off it). */
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
 * terminal belongs to another process, so neither the profile interview nor
 * the managed-browser sync prompts here.
 */
export async function openAppInBrowser(url: string, aiuiArgs: AiuiArgs): Promise<void> {
  try {
    const chromeCfg: ChromeConfig = { ...loadAiuiConfig().chrome };
    // `--aiui-browser-url` (flag-only since the browser-profiles redesign)
    // means the browser is managed elsewhere — open there, launch nothing.
    const action = decideBrowserAction(aiuiArgs, { browserUrl: aiuiArgs.browserUrl });
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

    if (aiuiArgs.browserUrl) {
      await openInSessionBrowser(aiuiArgs.browserUrl, url);
      console.error(chalk.dim(`aiui: opened ${url} in the browser at ${aiuiArgs.browserUrl}`));
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
