/**
 * `aiui browser` — start (or find) the session browser; `aiui open <url>` —
 * open a page in it.
 *
 * `aiui browser` is how the session browser exists *independently* of a
 * Claude session — the window up before (or without) `aiui claude`. The
 * remote-development flow (browser here, session on another box) is
 * `aiui remote <host>`, which owns the tunnels AND registers the remote
 * channel locally; the `--tunnel` flag that used to live here is retired
 * (docs/proposals/aiui-registry.md §5).
 *
 * Both commands identify the browser the same way `aiui claude` does: by the
 * profile's user data dir, via Chrome's own `DevToolsActivePort` file. The
 * find-or-start pipeline itself lives in util/session-browser.ts, shared with
 * `aiui remote` and `aiui vite`'s sidecar.
 */
import {
  discoverSessionBrowser,
  isCi,
  openInSessionBrowser,
  type SessionBrowser,
} from "@habemus-papadum/aiui-util";
import { type ChromeSettings, resolveChromeSettings } from "../util/chrome";
import { loadAiuiConfig } from "../util/config";
import { findOrStartSessionBrowser } from "../util/session-browser";
import { printError, printNote } from "../util/ui";

export interface BrowserOptions {
  profile?: string;
  dataDir?: string;
  port?: string;
  headless?: boolean;
  open?: string;
}

export async function runBrowser(opts: BrowserOptions): Promise<void> {
  const config = loadAiuiConfig();
  const chromeCfg = { ...config.chrome };
  if (chromeCfg.browserUrl) {
    printNote(
      `config pins chrome.browserUrl to ${chromeCfg.browserUrl} — the browser is managed elsewhere`,
      "Run `aiui browser` on the machine that should host it (and drop browserUrl there).",
    );
    return;
  }

  let debugPort: number | undefined;
  try {
    debugPort = parsePort(opts.port, "--port");
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !isCi();
  try {
    const { session, settings, started } = await findOrStartSessionBrowser({
      flags: { chromeProfile: opts.profile, chromeDataDir: opts.dataDir },
      config: chromeCfg,
      interactive,
      debugPort,
      headless: opts.headless,
      startUrl: opts.open,
    });
    report(
      started ? "session browser started" : "session browser already running",
      settings,
      session,
    );
    if (!started && opts.open) {
      await openInSessionBrowser(session.browserUrl, opts.open);
      console.log(`opened ${opts.open}`);
    }
  } catch (error) {
    printError(
      "the session browser failed to start",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
    return;
  }
}

function parsePort(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const port = Number(raw);
  if (!(Number.isInteger(port) && port >= 0 && port <= 65535)) {
    throw new Error(`invalid ${flag} ${raw} — expected 0..65535`);
  }
  return port;
}

function report(title: string, settings: ChromeSettings, session: SessionBrowser): void {
  console.log(title);
  console.log(`  profile:        ${settings.userDataDir}`);
  console.log(`  debug endpoint: ${session.browserUrl}`);
  console.log(
    "\nAn `aiui claude` in this profile's project attaches automatically. " +
      "For a session on another box, use `aiui remote <[user@]host>`.",
  );
}

/** `aiui open <url>` — open a page in the running session browser. */
export async function runOpen(
  url: string,
  opts: Pick<BrowserOptions, "profile" | "dataDir">,
): Promise<void> {
  const config = loadAiuiConfig();
  const settings = resolveChromeSettings(
    { chromeProfile: opts.profile, chromeDataDir: opts.dataDir },
    config.chrome ?? {},
  );
  // An explicitly configured endpoint (remote browser) is also openable.
  const browserUrl =
    config.chrome?.browserUrl ?? (await discoverSessionBrowser(settings.userDataDir))?.browserUrl;
  if (!browserUrl) {
    printError(
      "no session browser is running for this profile",
      `Start one with \`aiui browser\` (profile: ${settings.userDataDir}).`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    await openInSessionBrowser(browserUrl, url);
    console.log(`opened ${url}`);
  } catch (error) {
    printError(`couldn't open ${url}`, error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
