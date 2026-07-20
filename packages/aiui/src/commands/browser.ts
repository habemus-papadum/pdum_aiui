/**
 * `aiui open <url>` — the human-facing browser entry: open a page in the
 * shared session browser (the window `aiui claude` attaches the agent to),
 * starting one if none is running (the find-or-start pipeline in
 * util/session-browser.ts, shared with `aiui remote` and `aiui claude`).
 *
 * Opening into a RUNNING browser is unconditional — an explicit ask, and the
 * window already exists. STARTING one consults the same decision ladder the
 * sidecars use (`decideBrowserAction`): `chrome.enabled: false` refuses, and
 * a CI/headless environment gets the port-forwarding hint instead of a
 * browser nobody can see.
 *
 * The standalone `aiui browser` command is retired: `open` subsumes its only
 * everyday use (get the window up, put a page in it), and the remote-dev flow
 * is `aiui remote <host>`.
 */
import {
  type BrowserAction,
  decideBrowserAction,
  discoverSessionBrowser,
  isCi,
  openInSessionBrowser,
} from "@habemus-papadum/aiui-util";
import { resolveChromeSettings } from "../util/chrome";
import { loadAiuiConfig } from "../util/config";
import { startSessionBrowser } from "../util/session-browser";
import { printError, printNote } from "../util/ui";

export interface OpenOptions {
  profile?: string;
  dataDir?: string;
}

/**
 * Why a START would be refused, as the note to print — or undefined when
 * starting is fine. Pure (the testable half of {@link runOpen}'s decision).
 */
export function startRefusal(
  action: BrowserAction,
  url: string,
): { title: string; detail: string } | undefined {
  if (action.kind === "skip") {
    return {
      title: "browser opening is suppressed for this run — not starting one",
      detail: `Open ${url} yourself, or rerun without the suppress flag.`,
    };
  }
  if (action.kind === "hint") {
    return {
      title: `detected a headless environment (${action.reason}) — not starting a browser`,
      detail:
        `Assuming the port is already forwarded, open ${url} in the browser on your local\n` +
        "machine — or use `aiui remote <host>` from there for the whole flow.",
    };
  }
  return undefined;
}

/** `aiui open <url>` — open a page in the session browser, starting it if needed. */
export async function runOpen(url: string, opts: OpenOptions = {}): Promise<void> {
  const config = loadAiuiConfig();
  const chromeCfg = { ...config.chrome };
  try {
    const settings = resolveChromeSettings(
      { chromeProfile: opts.profile, chromeDataDir: opts.dataDir },
      chromeCfg,
    );
    const running = await discoverSessionBrowser(settings.userDataDir);
    if (running) {
      await openInSessionBrowser(running.browserUrl, url);
      console.log(`opened ${url}`);
      return;
    }

    // None running — starting one is the consequential act, so it goes
    // through the ladder. (No force/suppress flags here: `aiui open` under CI
    // with a browser deliberately running still opens above.)
    const refusal = startRefusal(decideBrowserAction({}), url);
    if (refusal) {
      printNote(refusal.title, refusal.detail);
      return;
    }
    const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !isCi();
    await startSessionBrowser({
      flags: { chromeProfile: opts.profile, chromeDataDir: opts.dataDir },
      config: chromeCfg,
      interactive,
      startUrl: url, // the start path opens the URL as the first tab
    });
    console.log(`opened ${url} (started the session browser)`);
  } catch (error) {
    printError(`couldn't open ${url}`, error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
