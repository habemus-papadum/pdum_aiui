/**
 * Bundle the shared debug UI into a browser-loadable ES module the panel loads
 * at runtime (`extension/js/debug-ui.js`).
 *
 * Why a separate esbuild step rather than the extension's `tsc`: the panel is
 * plain `tsc` output (no bundler) — and the session browser rebuilds the
 * extension by invoking `tsc` directly (see aiui's chrome.ts), so `tsc` must
 * stay the thing that emits the panel. But the debug UI lives in the overlay
 * package, whose source uses bundler-mode (extensionless) imports `tsc` can't
 * follow into a single browser file. esbuild reads the overlay's **source**
 * (editable install, no overlay build step) and bundles debug-ui + its
 * intent-pipeline dependency into one module. The panel imports it lazily, so a
 * `tsc`-only build (fresh checkout, before `pnpm build`) still yields a working
 * panel — the Intent pane just degrades until this bundle exists.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));

await build({
  entryPoints: [
    fileURLToPath(new URL("../aiui-dev-overlay/src/debug-ui/index.ts", import.meta.url)),
  ],
  outfile: `${here}extension/js/debug-ui.js`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  // Keep it readable — this is a dev-tool bundle, not shipped to end users.
  minify: false,
  logLevel: "info",
});
