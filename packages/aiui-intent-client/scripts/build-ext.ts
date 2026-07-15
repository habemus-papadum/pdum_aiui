/**
 * build-ext.ts — the MV3 bundle, built statically. `pnpm build:ext` (one-shot)
 * or `pnpm ext:watch` (rebuild on save).
 *
 * Three different shapes come out of one command, because MV3 demands three:
 *
 *  - **the panel** — a normal Vite build (HTML entry, ESM, Solid's JSX
 *    compiler). It is the same panel the channel serves as a plain page; only
 *    the entry differs.
 *  - **the content scripts** — bundled by esbuild to a self-contained **IIFE**.
 *    This is not a preference: MV3 content scripts are classic scripts, so an
 *    `import` in the emitted file is a syntax error at injection time and the
 *    page silently gets nothing.
 *  - **the service worker** — an ES module (the manifest says so), so esbuild
 *    emits ESM here.
 *
 * No CRXJS. The old extension used it for hot reloading, and paid for it with a
 * toolchain; the new client's hot-iteration surface is the plain page (a normal
 * dev server), so the extension only ever needs to be BUILT.
 *
 * `--watch` (`pnpm ext:watch`) keeps the SAME artifact rebuilt on every save —
 * Vite watches the panel graph, esbuild watches each bundle — and after each
 * rebuild RELOADS the extension into the running session browser (the same
 * `Extensions.loadUnpacked` as `pnpm load:ext`; discovered via the profile's
 * DevToolsActivePort, skipped quietly when no session browser is up). Reopen
 * the side panel after a reload; orphaned content scripts in open tabs
 * self-clean via the driver heartbeat and refresh on the next tab reload.
 * Outside the session browser you still reload by hand (chrome://extensions ⟳).
 *
 * The manifest and the mic worklet are written ONCE at startup even in watch
 * mode — they change rarely, and regenerating the manifest means re-evaluating
 * its module. Editing `src/ext/manifest.ts` (or its `./protocol` import) logs a
 * reminder to restart the watcher; everything else rebuilds live.
 */

import { existsSync, watch as fsWatch } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PCM_WORKLET_SOURCE } from "@habemus-papadum/aiui-dev-overlay/multimodal-talk";
import { discoverSessionBrowser, loadUnpackedExtension } from "@habemus-papadum/aiui-util";
import {
  type BuildOptions,
  build as esbuild,
  context as esbuildContext,
  type Plugin,
} from "esbuild";
import { type InlineConfig, build as viteBuild } from "vite";
import solid from "vite-plugin-solid";
import { manifest } from "../src/ext/manifest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const extRoot = join(packageRoot, "src/ext");
const outDir = join(packageRoot, "dist-ext");
/** The session browser's profile — where its DevToolsActivePort lives. */
const profileDir = join(packageRoot, "..", "..", ".aiui-cache", "chrome", "default");

const watch = process.argv.includes("--watch");

/** Watch mode's session-browser reloader; esbuild's onEnd calls it per pass. */
let onRebuilt: (() => void) | undefined;

// 1. The panel: Vite, because it is a Solid app with an HTML entry.
//
// `configFile: false` — deliberately NOT this package's vite.config.ts. That
// config builds a LIBRARY, and its defining act is to externalize every declared
// dependency so a consumer's bundler supplies them. An extension page has no
// consumer and no import map: a surviving bare specifier is a hard boot failure
// ("Failed to resolve module specifier \"@solidjs/web\"" — measured, 2026-07-13,
// which is how this comment exists). An app build must INLINE what a library
// build externalizes, so the two configs cannot be one.
//
// In watch mode `build.watch` makes Vite rebuild the panel on any change in its
// graph; the returned promise still resolves (the watcher keeps the process
// alive), so control falls through to the esbuild watchers below.
function panelConfig(): InlineConfig {
  return {
    configFile: false,
    plugins: [solid()],
    root: extRoot,
    base: "./",
    resolve: { conditions: ["browser", "import", "module", "default"] },
    build: {
      outDir,
      emptyOutDir: false,
      rollupOptions: { input: join(extRoot, "index.html") },
      target: "chrome120",
      sourcemap: true,
      ...(watch ? { watch: {} } : {}),
    },
    logLevel: watch ? "info" : "warn",
  };
}

// 2. The content scripts (IIFE — see the module doc) and the worker (ESM).
const bundles: { entry: string; out: string; format: "iife" | "esm" }[] = [
  { entry: "content.ts", out: "content.js", format: "iife" },
  { entry: "content-main.ts", out: "content-main.js", format: "iife" },
  { entry: "sw.ts", out: "sw.js", format: "esm" },
];

// A one-line "✓ rebuilt <file>" on each esbuild pass, so a watch run shows work
// the way Vite's own logger does. Only added in watch mode; it changes nothing
// about the emitted bytes, so build:ext and ext:watch produce the same artifact.
function logRebuilds(out: string): Plugin {
  return {
    name: "aiui:log-rebuilds",
    setup(build) {
      let first = true;
      build.onEnd((result) => {
        const errs = result.errors.length;
        if (errs) console.error(`✗ ${out} — ${errs} error${errs > 1 ? "s" : ""}`);
        else if (!first) {
          console.info(`✓ rebuilt ${out}`);
          // Not on the FIRST pass: at startup Vite may still be writing the
          // panel, and a reload against a half-built dist-ext fails ("Side
          // panel file path must exist" — caught live). The startup reload
          // rides Vite's own initial END event instead.
          onRebuilt?.();
        }
        first = false;
      });
    },
  };
}

function esbuildOptions(entry: string, out: string, format: "iife" | "esm"): BuildOptions {
  return {
    entryPoints: [join(extRoot, entry)],
    outfile: join(outDir, out),
    bundle: true,
    format,
    platform: "browser",
    target: "chrome120",
    logLevel: "warning",
    ...(watch ? { plugins: [logRebuilds(out)] } : {}),
  };
}

// 3. The mic worklet, as a real FILE. An extension page's CSP (`script-src
// 'self'`) rejects the blob: worklet module the plain page loads happily —
// "AbortError: Unable to load a worklet's module", measured by the old client.
// Emitting it from the SAME constant the source uses means the shipped copy
// cannot drift from the one the code expects (the old extension needed a test
// to guarantee that; this needs none).
//
// 4. The manifest. Both are one-shot writes — even under --watch — because they
// change rarely and the manifest is a module, not a file to copy.
async function writeStatics(): Promise<void> {
  await writeFile(join(outDir, "pcm-worklet.js"), PCM_WORKLET_SOURCE);
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const iconsSrc = join(extRoot, "icons");
  const iconsOut = join(outDir, "icons");
  await mkdir(iconsOut, { recursive: true });
  for (const file of await readdir(iconsSrc)) {
    await copyFile(join(iconsSrc, file), join(iconsOut, file));
  }
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

if (!watch) {
  await viteBuild(panelConfig());
  for (const b of bundles) await esbuild(esbuildOptions(b.entry, b.out, b.format));
  await writeStatics();
  console.info(`intent client extension → ${outDir}`);
  console.info("load it unpacked at chrome://extensions (Developer mode → Load unpacked)");
} else {
  await writeStatics();
  // Vite: initial panel build + watcher. esbuild: one watching context per bundle.
  const panel = await viteBuild(panelConfig());
  const contexts = await Promise.all(
    bundles.map((b) => esbuildContext(esbuildOptions(b.entry, b.out, b.format))),
  );
  await Promise.all(contexts.map((c) => c.watch()));

  // After every rebuild, RELOAD the extension into the running session browser
  // — the same `Extensions.loadUnpacked` the one-shot `pnpm load:ext` uses
  // (idempotent; the id comes from the manifest key, so it never moves).
  // Closing/reopening the side panel refreshes only the PANEL document; the
  // worker and manifest need this reload. Content scripts already running in
  // open tabs are ORPHANED by it — their pages self-clean via the driver
  // heartbeat (src/page/driver-watch.ts) and pick up the new build on the next
  // tab reload. No session browser running → skip quietly, keep watching.
  // (Debounced: one save can end several watchers — panel + content + sw.)
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReload = (): void => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      void (async () => {
        // A complete dist-ext or no reload: at startup the three builders
        // land at different times, and Chrome rejects a half-written dir.
        const complete = ["index.html", "content.js", "sw.js", "manifest.json"].every((f) =>
          existsSync(join(outDir, f)),
        );
        if (!complete) {
          return;
        }
        const session = await discoverSessionBrowser(profileDir);
        if (session === undefined) {
          return;
        }
        const loaded = await loadUnpackedExtension(session.browserUrl, outDir);
        console.info(
          loaded.ok
            ? `↻ reloaded into the session browser (${loaded.extensionId})`
            : `✗ extension reload failed: ${loaded.detail}`,
        );
      })();
    }, 400);
  };
  onRebuilt = scheduleReload;
  // Vite's watcher announces each pass with an END event.
  if (panel !== undefined && typeof panel === "object" && "on" in panel) {
    (panel as { on(event: string, cb: (e: { code?: string }) => void): unknown }).on(
      "event",
      (e) => {
        if (e.code === "END") {
          scheduleReload();
        }
      },
    );
  }

  // The manifest/worklet are frozen for this run (see writeStatics); editing
  // their source can't take effect without re-evaluating the module, so tell the
  // human to restart rather than silently serve a stale manifest.
  for (const file of ["manifest.ts", "protocol.ts"]) {
    fsWatch(join(extRoot, file), () =>
      console.info(
        `↻ src/ext/${file} changed — restart \`pnpm ext:watch\` to regenerate manifest.json`,
      ),
    );
  }

  const shutdown = async (): Promise<void> => {
    await Promise.all(contexts.map((c) => c.dispose()));
    // `panel` is a RollupWatcher when build.watch is set.
    if (panel && "close" in panel) await panel.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.info(`intent client extension → ${outDir} (watching; Ctrl-C to stop)`);
  console.info(
    "rebuilds auto-reload into the running session browser; reopen the side panel " +
      "after one (elsewhere: chrome://extensions ⟳)",
  );
}
