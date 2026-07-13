/**
 * build-ext.ts — the MV3 bundle, built statically. `pnpm build:ext`.
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
 */

import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PCM_WORKLET_SOURCE } from "@habemus-papadum/aiui-dev-overlay/multimodal-talk";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import solid from "vite-plugin-solid";
import { manifest } from "../src/ext/manifest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const outDir = join(packageRoot, "dist-ext");

await rm(outDir, { recursive: true, force: true });

// 1. The panel: Vite, because it is a Solid app with an HTML entry.
//
// `configFile: false` — deliberately NOT this package's vite.config.ts. That
// config builds a LIBRARY, and its defining act is to externalize every declared
// dependency so a consumer's bundler supplies them. An extension page has no
// consumer and no import map: a surviving bare specifier is a hard boot failure
// ("Failed to resolve module specifier \"@solidjs/web\"" — measured, 2026-07-13,
// which is how this comment exists). An app build must INLINE what a library
// build externalizes, so the two configs cannot be one.
await viteBuild({
  configFile: false,
  plugins: [solid()],
  root: join(packageRoot, "src/ext"),
  base: "./",
  resolve: { conditions: ["browser", "import", "module", "default"] },
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: { input: join(packageRoot, "src/ext/index.html") },
    target: "chrome120",
    sourcemap: true,
  },
  logLevel: "warn",
});

// 2. The content scripts (IIFE — see the module doc) and the worker (ESM).
const bundle = async (entry: string, out: string, format: "iife" | "esm"): Promise<void> => {
  await esbuild({
    entryPoints: [join(packageRoot, "src/ext", entry)],
    outfile: join(outDir, out),
    bundle: true,
    format,
    platform: "browser",
    target: "chrome120",
    logLevel: "warning",
  });
};
await bundle("content.ts", "content.js", "iife");
await bundle("content-main.ts", "content-main.js", "iife");
await bundle("sw.ts", "sw.js", "esm");

// 3. The mic worklet, as a real FILE. An extension page's CSP (`script-src
// 'self'`) rejects the blob: worklet module the plain page loads happily —
// "AbortError: Unable to load a worklet's module", measured by the old client.
// Emitting it from the SAME constant the source uses means the shipped copy
// cannot drift from the one the code expects (the old extension needed a test
// to guarantee that; this needs none).
await writeFile(join(outDir, "pcm-worklet.js"), PCM_WORKLET_SOURCE);

// 4. The manifest.
await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.info(`intent client extension → ${outDir}`);
console.info("load it unpacked at chrome://extensions (Developer mode → Load unpacked)");
