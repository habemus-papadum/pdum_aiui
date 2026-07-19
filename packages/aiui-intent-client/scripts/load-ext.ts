/**
 * load-ext.ts — install the built extension into the running session browser.
 * `pnpm build:ext && pnpm load:ext`, or just `pnpm ext`.
 *
 * "Load unpacked" without the human: CDP's `Extensions.loadUnpacked` is what the
 * chrome://extensions button calls, and the session browser already exposes a
 * debug port (that is the whole posture — docs/guide/warning.md). Chrome installs
 * unpacked extensions BY PATH, so this is idempotent: re-running it after a
 * rebuild reloads the same extension in place, and the id never moves (it comes
 * from the manifest key, not the path).
 *
 * Why this is a separate act rather than something `aiui claude` does for you:
 * the frozen client is still auto-loaded, and installing this one is a decision
 * to drive with it (see the retired parity ledger's switchover row, archive/intent-client/PARITY.md), so it stays a command you
 * run. (This client's ⌘. no longer collides with the frozen extension's ⌘B,
 * so the two can coexist without fighting over the chord.)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSessionBrowser, loadUnpackedExtension } from "@habemus-papadum/aiui-util";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = join(here, "..", "dist-ext");
// The project-local profile the session browser runs on (packages/aiui/src/util).
const profile = join(here, "..", "..", "..", ".aiui-cache", "chrome", "default");

const session = await discoverSessionBrowser(profile);
if (session === undefined) {
  console.error(
    "no session browser running — start one (`aiui claude`, or `aiui browser`) and re-run.",
  );
  process.exit(1);
}

const loaded = await loadUnpackedExtension(session.browserUrl, extDir);
if (!loaded.ok) {
  console.error(`couldn't load the extension: ${loaded.detail}`);
  console.error(`load it by hand instead: chrome://extensions → Load unpacked → ${extDir}`);
  process.exit(1);
}

console.info(`intent client loaded: ${loaded.extensionId}`);
console.info("open the panel with ⌘. (or the toolbar button) on the tab you want to drive.");
