/**
 * The browser sidecar's runner: `open-browser-cli.ts <url> <repo-root>`.
 *
 * Spawned by vite.config.ts (via tsx, the same source-first trick as the
 * channel server) rather than imported: Vite bundles a config file but
 * *externalizes* every bare import, so workspace packages reached from the
 * config graph get loaded by plain Node — which can't resolve the linked TS
 * sources' extensionless relative imports. Under tsx, src/open-browser.ts and
 * the aiui-util plumbing it shares with `aiui vite` load like anywhere else
 * in the workspace.
 *
 * Everything is printed to stdout for the parent to `[workbench]`-prefix, and
 * the exit code is always 0 once the args parse: whatever the browser does,
 * the workbench runs on.
 */
import { openWorkbenchInBrowser, workbenchBrowserAction } from "./open-browser";

const [url, repoRoot] = process.argv.slice(2);
if (!url || !repoRoot) {
  console.error("usage: open-browser-cli.ts <url> <repo-root>");
  process.exit(2);
}

const action = workbenchBrowserAction();
if (action.kind === "hint") {
  console.log(
    `headless environment (${action.reason}) — not opening a browser; ` +
      `open ${url} on your own machine (WORKBENCH_BROWSER=1 opens one here anyway)`,
  );
} else if (action.kind === "open") {
  try {
    console.log(await openWorkbenchInBrowser(url, repoRoot));
  } catch (error) {
    console.log(
      `couldn't open a browser (${
        error instanceof Error ? error.message : String(error)
      }) — open ${url} yourself`,
    );
  }
}
