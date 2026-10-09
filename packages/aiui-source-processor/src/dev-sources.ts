/**
 * dev-sources.ts — the dev server's twin of ./ship-sources: the page learns
 * which of its own files it can read, and where, without a build. The plugin
 * serves `__aiui/sources.json` — every app file on disk under the root and
 * the locator's stamp roots (code, styles, markdown, json; never
 * node_modules, dist, or a dot-directory), keyed by STAMP path and mapped to
 * Vite's `/@fs/…` URL, which aiui-viz's source reader imports as a `?raw`
 * string module — and seeds `window.__AIUI__.sources = { base, manifest,
 * mode: "dev" }` so the reader, the `sources`/`source` tools and the dock's
 * source browser find it.
 *
 * Disk, not the module graph: a lazily-routed app has loaded a fraction of
 * its files at any moment, and a browser wants the whole tree. The walk is
 * cheap (a few hundred files) and re-run per request, so a file added while
 * the server runs appears on the next listing.
 */
import { type Dirent, readdirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Plugin } from "vite";
import { SHIPPED_FILE, SOURCES_MANIFEST } from "./ship-sources.ts";

/** Directory names the walk never enters (plus any name starting with a dot). */
const SKIP_DIRS = new Set(["node_modules", "coverage", "tmp"]);

/** The one fs call the walk makes — the test seam. */
export type ReadDir = (dir: string) => Array<Pick<Dirent, "name" | "isDirectory" | "isFile">>;

export interface DevSourcesOptions {
  /** Directories besides the root whose files are app code (the locator's `stampRoots`). */
  roots?: string[];
  /** Test seam: list one directory. */
  readDir?: ReadDir;
}

const toPosix = (p: string): string => p.split(sep).join("/");

function skipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith(".") || name.startsWith("dist");
}

function walk(dir: string, readDir: ReadDir, out: string[]): void {
  let entries: ReturnType<ReadDir>;
  try {
    entries = readDir(dir);
  } catch {
    return; // a root that is not there lists nothing
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDir(entry.name)) walk(path, readDir, out);
    } else if (entry.isFile() && SHIPPED_FILE.test(entry.name)) {
      out.push(path);
    }
  }
}

/**
 * Every app file under the root and the extra roots, as `stamp path →
 * /@fs URL`, sorted by stamp path. A file reachable from two roots is listed
 * once.
 */
export function listSourceFiles(
  root: string,
  roots: readonly string[] = [],
  readDir: ReadDir = (dir) => readdirSync(dir, { withFileTypes: true }),
): Record<string, string> {
  const files: string[] = [];
  for (const dir of [root, ...roots]) walk(dir, readDir, files);
  const out: Record<string, string> = {};
  for (const file of [...new Set(files)].sort()) {
    const stamp = toPosix(relative(root, file));
    if (!isAbsolute(file) || stamp in out) continue;
    out[stamp] = `/@fs/${toPosix(file).replace(/^\//, "")}`;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** The plugin (see the module doc). `aiui()` adds it to every dev server. */
export function devSources(options: DevSourcesOptions = {}): Plugin {
  let root = "";
  let base = "/";
  const readDir = options.readDir;
  return {
    name: "aiui:dev-sources",
    apply: "serve",
    configResolved(config) {
      root = config.root;
      base = config.base;
    },
    transformIndexHtml() {
      return [
        {
          tag: "script",
          injectTo: "head-prepend" as const,
          children: `(window.__AIUI__ ??= { v: 1 }).sources = ${JSON.stringify({
            base,
            manifest: `${base}${SOURCES_MANIFEST}`,
            mode: "dev",
          })};`,
        },
      ];
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = (req.url ?? "").split("?")[0] ?? "";
        // Vite may hand the URL with or without the base already stripped.
        const path = base !== "/" && raw.startsWith(base) ? `/${raw.slice(base.length)}` : raw;
        if (path !== `/${SOURCES_MANIFEST}`) {
          next();
          return;
        }
        const files = listSourceFiles(root, options.roots ?? [], readDir);
        const body = JSON.stringify({ files });
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(body);
      });
    },
  };
}
