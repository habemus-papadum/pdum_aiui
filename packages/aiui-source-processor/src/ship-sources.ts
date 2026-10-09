/**
 * ship-sources.ts — `aiui({ sources: "ship" })`: a production build that
 * carries its own source, so the `source` page tool (aiui-viz's standard
 * tools) answers on a published site exactly as it does on a dev server.
 *
 * Build-only. The plugin watches the ids Vite transforms, keeps the app's own
 * files (under the root or a declared stamp root; never node_modules; code,
 * styles, markdown, json), and at generateBundle emits each one UNCHANGED
 * from disk under `__aiui/src/`, plus a manifest, `__aiui/sources.json`,
 * mapping the path a stamp uses ("../seismos/src/ui/App.tsx") to the
 * published one ("__aiui/src/up/seismos/src/ui/App.tsx" — a dotdot segment
 * becomes `up/`, since an emitted file name cannot climb). The page learns
 * where to look through `window.__AIUI__.sources = { base, manifest, mode:
 * "shipped" }`; aiui-viz's source reader fetches the manifest lazily, then
 * the file. (The dev server's listing is ./dev-sources — same manifest shape,
 * `/@fs` URLs instead of published paths.)
 *
 * Shipping sources PUBLISHES them. The option is off by default and belongs
 * on a site whose code is public anyway (the gallery of a public repo). It
 * pairs with the stamps every build carries (unless `stampJsx: false`) and an
 * explicit `sourceRoot` URL, so attribution on the published page links
 * somewhere a person can click.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { Plugin } from "vite";

/** Where the shipped files live, relative to the app's base. */
export const SOURCES_DIR = "__aiui/src";
/** The manifest's published path, relative to the app's base. */
export const SOURCES_MANIFEST = "__aiui/sources.json";
/** What counts as a source file to ship or list: code, styles, markdown, json. */
export const SHIPPED_FILE = /\.(m?[tj]sx?|css|md|json)$/;

export interface ShipSourcesOptions {
  /** Directories besides the root whose files are app code (the locator's `stampRoots`). */
  roots?: string[];
  /** Test seam: read one file's text. */
  read?: (file: string) => string;
}

/** `__aiui/sources.json`: stamp path → published path (relative to the base). */
export interface SourcesManifest {
  files: Record<string, string>;
}

/** The published path for a stamp path: `../x/y.ts` → `__aiui/src/up/x/y.ts`. */
export function shippedPath(stampPath: string): string {
  const parts = stampPath.split("/").map((part) => (part === ".." ? "up" : part));
  return `${SOURCES_DIR}/${parts.join("/")}`;
}

const toPosix = (p: string): string => p.split(sep).join("/");
const asDir = (p: string): string => `${p.replace(/[\\/]+$/, "")}${sep}`;

/** The plugin (see the module doc). `aiui({ sources: "ship" })` adds it. */
export function shipSources(options: ShipSourcesOptions = {}): Plugin {
  let root = "";
  let base = "/";
  const roots = (options.roots ?? []).map(asDir);
  const read = options.read ?? ((file: string) => readFileSync(file, "utf8"));
  /** stamp path → absolute file, in first-seen order. */
  const seen = new Map<string, string>();
  return {
    name: "aiui:ship-sources",
    apply: "build",
    configResolved(config) {
      root = config.root;
      base = config.base;
    },
    transform(_code, id) {
      const file = id.replace(/[?#].*$/, "");
      if (!SHIPPED_FILE.test(file) || !isAbsolute(file) || file.includes("node_modules"))
        return null;
      const own = file.startsWith(asDir(root)) || roots.some((dir) => file.startsWith(dir));
      if (!own) return null;
      seen.set(toPosix(relative(root, file)), file);
      return null;
    },
    transformIndexHtml() {
      return [
        {
          tag: "script",
          injectTo: "head-prepend" as const,
          children: `(window.__AIUI__ ??= { v: 1 }).sources = ${JSON.stringify({
            base,
            manifest: `${base}${SOURCES_MANIFEST}`,
            mode: "shipped",
          })};`,
        },
      ];
    },
    generateBundle() {
      const files: Record<string, string> = {};
      for (const [stamp, file] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
        const published = shippedPath(stamp);
        files[stamp] = published;
        this.emitFile({ type: "asset", fileName: published, source: read(file) });
      }
      this.emitFile({
        type: "asset",
        fileName: SOURCES_MANIFEST,
        source: JSON.stringify({ files } satisfies SourcesManifest),
      });
    },
  };
}
