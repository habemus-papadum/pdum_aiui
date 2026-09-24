/**
 * duckdb-assets.ts — self-hosted DuckDB-WASM binaries, one layout for every
 * wasm connector.
 *
 * The problem: duckdb-wasm's binaries are 36–41 MB each. A CDN (jsDelivr)
 * is a third-party runtime dependency; Vite `?url` imports hash the names and
 * can't be found by anything but the importing module; and the MotherDuck
 * client (`@motherduck/wasm-client`) has its own fixed idea of where the
 * files live — `<prefix>/duckdb-wasm-assets/<version>/duckdb-eh.wasm` and
 * siblings, the layout MotherDuck's own CDN uses, addressed by its
 * `duckDBAssetsURLPrefix` option.
 *
 * So this plugin publishes the INSTALLED `@duckdb/duckdb-wasm`'s files at
 * exactly that layout under the app's own origin — served in dev, emitted
 * unhashed into the build — and tells the page where they are through
 * `window.__AIUI__.duckdbAssets = { prefix, version }` (not a secret; present
 * in builds too). Plain DuckDB apps read it back with aiui-viz's
 * `duckdbAssetBundles()`; a MotherDuck app passes `duckdbAssetsLocation().prefix`
 * as `duckDBAssetsURLPrefix`. Same files, same URLs, whichever engine.
 *
 * `brotli: true` also emits `<file>.br` siblings for a host that serves
 * `Content-Encoding: br` (Cloudflare Workers assets cap a file at 25 MiB; the
 * eh wasm is ~6 MB compressed). Build only — dev serves the raw files.
 *
 * Only `mvp` + `eh` ship (no `coi`: the threaded bundle needs COOP/COEP
 * headers a static host can't set; `selectBundle` picks `eh` on every modern
 * browser — aiui-viz/duckdb.ts).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { brotliCompressSync, constants as zlib } from "node:zlib";
import type { Plugin } from "vite";

/** The four files a `mvp` + `eh` deployment needs, by their dist names. */
export const DUCKDB_ASSET_FILES = [
  "duckdb-eh.wasm",
  "duckdb-mvp.wasm",
  "duckdb-browser-eh.worker.js",
  "duckdb-browser-mvp.worker.js",
] as const;

/** The directory the layout hangs under — the MotherDuck client's convention. */
export const DUCKDB_ASSETS_DIR = "duckdb-wasm-assets";

export interface DuckdbAssetsLayout {
  /** The installed `@duckdb/duckdb-wasm` version — the layout's path segment. */
  version: string;
  /** Its `dist/` directory on disk. */
  distDir: string;
}

/**
 * Locate the app's installed duckdb-wasm: resolve the package from the app
 * root's own dependency graph (so a workspace picks the deduped copy the app
 * actually imports), then read its version.
 */
export function locateDuckdbAssets(from: string): DuckdbAssetsLayout {
  const require = createRequire(join(from, "package.json"));
  // The node entry (`dist/duckdb-node.cjs`) is exported on every version; the
  // package.json itself is not, so find the dist through the entry.
  const entry = require.resolve("@duckdb/duckdb-wasm");
  const distDir = dirname(entry);
  const pkg = JSON.parse(readFileSync(join(distDir, "..", "package.json"), "utf8")) as {
    version: string;
  };
  return { version: pkg.version, distDir };
}

export interface DuckdbAssetsOptions {
  /** Also emit brotli `.br` siblings in the build (quality 9). Default false. */
  brotli?: boolean;
  /** Resolve `@duckdb/duckdb-wasm` from here instead of the Vite root. */
  resolveFrom?: string;
  /** Test seam: a fixed layout instead of resolution. */
  layout?: DuckdbAssetsLayout;
}

const CONTENT_TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".js": "text/javascript",
};

function contentType(file: string): string {
  const dot = file.lastIndexOf(".");
  return CONTENT_TYPES[file.slice(dot)] ?? "application/octet-stream";
}

/** The published path of one file, relative to the app's base. */
export function duckdbAssetPath(version: string, file: string): string {
  return `${DUCKDB_ASSETS_DIR}/${version}/${file}`;
}

/** The plugin (see the module doc). `aiui({ duckdbAssets: true })` adds it. */
export function duckdbAssets(options: DuckdbAssetsOptions = {}): Plugin {
  let layout: DuckdbAssetsLayout | undefined;
  let base = "/";
  const resolved = (): DuckdbAssetsLayout => {
    if (layout === undefined) {
      throw new Error("aiui:duckdb-assets used before configResolved");
    }
    return layout;
  };
  return {
    name: "aiui:duckdb-assets",
    configResolved(config) {
      base = config.base;
      layout = options.layout ?? locateDuckdbAssets(options.resolveFrom ?? config.root);
    },
    // Both serve and build: the page must know the prefix and the version to
    // form the URLs, and neither is a secret.
    transformIndexHtml() {
      const { version } = resolved();
      return [
        {
          tag: "script",
          injectTo: "head-prepend" as const,
          children: `(window.__AIUI__ ??= { v: 1 }).duckdbAssets = ${JSON.stringify({ prefix: base, version })};`,
        },
      ];
    },
    configureServer(server) {
      const { version, distDir } = resolved();
      const known = new Map<string, string>();
      for (const file of DUCKDB_ASSET_FILES) {
        known.set(`/${duckdbAssetPath(version, file)}`, join(distDir, file));
      }
      server.middlewares.use((req, res, next) => {
        const raw = (req.url ?? "").split("?")[0];
        // Vite may hand the URL with or without the base already stripped.
        const path = base !== "/" && raw.startsWith(base) ? `/${raw.slice(base.length)}` : raw;
        const onDisk = known.get(path);
        if (onDisk === undefined) {
          next();
          return;
        }
        const body = readFileSync(onDisk);
        res.setHeader("Content-Type", contentType(onDisk));
        res.setHeader("Content-Length", String(body.byteLength));
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.end(body);
      });
    },
    generateBundle() {
      const { version, distDir } = resolved();
      for (const file of DUCKDB_ASSET_FILES) {
        const source = readFileSync(join(distDir, file));
        this.emitFile({ type: "asset", fileName: duckdbAssetPath(version, file), source });
        if (options.brotli === true) {
          this.emitFile({
            type: "asset",
            fileName: `${duckdbAssetPath(version, file)}.br`,
            source: brotliCompressSync(source, {
              params: { [zlib.BROTLI_PARAM_QUALITY]: 9 },
            }),
          });
        }
      }
    },
  };
}
