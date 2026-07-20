/**
 * `aiui open <url>` — the human-facing browser entry: open a page in the
 * shared session browser (the window `aiui claude` attaches the agent to),
 * starting one if none is running (the find-or-start pipeline in
 * util/session-browser.ts, shared with `aiui remote` and `aiui claude`).
 *
 * The standalone `aiui browser` command is retired: `open` subsumes its only
 * everyday use (get the window up, put a page in it), and the remote-dev flow
 * is `aiui remote <host>`.
 */
import { isCi, openInSessionBrowser } from "@habemus-papadum/aiui-util";
import { loadAiuiConfig } from "../util/config";
import { findOrStartSessionBrowser } from "../util/session-browser";
import { printError } from "../util/ui";

export interface OpenOptions {
  profile?: string;
  dataDir?: string;
}

/** `aiui open <url>` — open a page in the session browser, starting it if needed. */
export async function runOpen(url: string, opts: OpenOptions = {}): Promise<void> {
  const config = loadAiuiConfig();
  const chromeCfg = { ...config.chrome };
  try {
    // An explicitly configured endpoint (a browser managed elsewhere — e.g.
    // the remote-development split) is also openable, and nothing local is
    // started for it.
    if (chromeCfg.browserUrl) {
      await openInSessionBrowser(chromeCfg.browserUrl, url);
      console.log(`opened ${url} (browser at ${chromeCfg.browserUrl})`);
      return;
    }
    const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !isCi();
    const { session, started } = await findOrStartSessionBrowser({
      flags: { chromeProfile: opts.profile, chromeDataDir: opts.dataDir },
      config: chromeCfg,
      interactive,
      startUrl: url, // the start path opens the URL as the first tab
    });
    if (!started) {
      await openInSessionBrowser(session.browserUrl, url);
    }
    console.log(`opened ${url}${started ? " (started the session browser)" : ""}`);
  } catch (error) {
    printError(`couldn't open ${url}`, error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
