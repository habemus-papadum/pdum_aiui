/**
 * The workbench's browser sidecar — the same autolaunch behavior as `aiui
 * vite`: once the workbench UI is listening, put it in front of the user in
 * the *session browser* (the shared window `aiui claude` attaches the agent
 * to), and in headless environments (CI, SSH, no display) don't open a
 * browser nobody can see — the caller prints where to point one instead. The
 * decision ladder and the session-browser plumbing are shared via
 * `@habemus-papadum/aiui-util`; this module only maps the workbench's
 * conventions onto them. Node-side, shared with its tests.
 *
 * `pnpm workbench` has no CLI flag surface (it's plain `vite`), so the
 * force/suppress escape hatches ride the same `WORKBENCH_*` env convention as
 * the ports: `WORKBENCH_BROWSER=1` opens a browser even where the environment
 * looks headless (the `--aiui-browser` analog), `WORKBENCH_BROWSER=0` never
 * opens one (`--aiui-no-browser`).
 */
import { join } from "node:path";
import { projectCacheDir } from "@habemus-papadum/aiui-claude-channel";
import {
  type BrowserAction,
  decideBrowserAction,
  discoverSessionBrowser,
  launchSessionBrowser,
  openInSessionBrowser,
  sessionBrowserBinary,
} from "@habemus-papadum/aiui-util";

/** The `WORKBENCH_BROWSER` values, mapped onto the shared decision ladder. */
export function workbenchBrowserAction(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BrowserAction {
  return decideBrowserAction(
    { browser: env.WORKBENCH_BROWSER === "1", noBrowser: env.WORKBENCH_BROWSER === "0" },
    {},
    env,
    platform,
  );
}

/**
 * Open the workbench in the session browser, `aiui vite`-sidecar style: a
 * running one gets a new tab; none running means launching one. The profile
 * is the *repo root's* default (`.aiui-cache/chrome/default` — the same
 * convention as aiui's chromeUserDataDir), so an `aiui claude` session in
 * this repo and the workbench share one window — and a browser the workbench
 * launches is the one a later `aiui claude` attaches to.
 *
 * The launch is the bare shared one — no Chrome for Testing sync and no
 * devtools-extension autoload; those are aiui-CLI affordances (`aiui
 * browser` builds the richer window). Throws when no browser can be found or
 * opened; the caller decides how loudly to say so, and the workbench keeps
 * running regardless. Returns a short "what happened" fragment for the ready
 * log line.
 */
export async function openWorkbenchInBrowser(url: string, repoRoot: string): Promise<string> {
  const userDataDir = join(projectCacheDir(repoRoot), "chrome", "default");
  const running = await discoverSessionBrowser(userDataDir);
  if (running) {
    await openInSessionBrowser(running.browserUrl, url);
    return "opened in the session browser";
  }
  await launchSessionBrowser({
    binary: sessionBrowserBinary({}),
    userDataDir,
    startUrl: url,
  });
  return "opened in a new session browser";
}
