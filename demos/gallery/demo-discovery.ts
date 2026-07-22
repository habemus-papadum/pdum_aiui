/**
 * demo-discovery.ts — the gallery's Vite plugin for MARKER-DRIVEN demo
 * discovery: scan the sibling `demos/*` packages for an `aiui.sitePage`
 * manifest field, resolve each one's page entry through its own `exports`
 * map, and serve the result as the `virtual:demo-pages` module. Adding a demo
 * to the gallery = giving its package the marker — no registration edits
 * here, no dependency line in the gallery's package.json.
 *
 * The marker (see aiui-viz's site-page.ts for the page contract):
 *
 * ```jsonc
 * "aiui": { "sitePage": { "title": "morphogen", "desc": "reaction–diffusion lab",
 *                          "order": 10, "entry": "./page" } }
 * ```
 *
 * `order` positions the tab; the LOWEST order is the default route. `entry`
 * (default "./page") names an export subpath whose target must be a plain
 * string (the source-first dev shape — bare `"./page": "./src/page.tsx"`),
 * because this plugin resolves it OUTSIDE node resolution: the demos are
 * deliberately NOT dependencies of the gallery, so the entry is turned into a
 * real file path here (`demo-page:<slug>` → absolute path in resolveId), and
 * every deeper import then resolves from the demo's own directory — its own
 * node_modules, its own workspace links.
 *
 * Live-ish: the demo package.jsons are watched, so editing a marker reloads
 * the shell. Creating a brand-new demo directory needs a dev-server restart
 * (directory creation isn't in the watch set) — acceptable for an act that
 * starts with `pnpm new-demo` + `pnpm install` anyway.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

interface SitePageMarker {
  title?: string;
  desc?: string;
  order?: number;
  entry?: string;
}

interface DiscoveredDemo {
  slug: string;
  title: string;
  desc: string;
  order: number;
  /** Absolute path of the page entry module. */
  entryFile: string;
}

const VIRTUAL_ID = "virtual:demo-pages";
const RESOLVED_VIRTUAL_ID = "\0virtual:demo-pages";
const ENTRY_PREFIX = "demo-page:";

function discover(demosRoot: string): DiscoveredDemo[] {
  const found: DiscoveredDemo[] = [];
  for (const slug of readdirSync(demosRoot)) {
    const dir = join(demosRoot, slug);
    const pkgPath = join(dir, "package.json");
    let pkg: {
      exports?: Record<string, unknown>;
      aiui?: { sitePage?: SitePageMarker };
    };
    try {
      if (!statSync(dir).isDirectory()) continue;
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue; // not a package (or unreadable) — not a candidate
    }
    const marker = pkg.aiui?.sitePage;
    if (!marker) continue; // opt-in: unmarked demos (oscillator, twins…) stay out
    const entrySubpath = marker.entry ?? "./page";
    const target = pkg.exports?.[entrySubpath];
    if (typeof target !== "string") {
      throw new Error(
        `demo-discovery: ${slug}/package.json has aiui.sitePage but its exports["${entrySubpath}"] ` +
          `is ${target === undefined ? "missing" : "not a plain string"} — the marker's entry must ` +
          `name a source-first export (e.g. "./page": "./src/page.tsx")`,
      );
    }
    found.push({
      slug,
      title: marker.title ?? slug,
      desc: marker.desc ?? "",
      order: marker.order ?? Number.MAX_SAFE_INTEGER,
      entryFile: resolve(dir, target),
    });
  }
  // Stable presentation: by order, then slug (so equal orders don't shuffle).
  return found.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

/** The gallery's demo-discovery plugin. `demosRoot` is the demos/ directory. */
export function demoPages(demosRoot: string): Plugin {
  let demos: DiscoveredDemo[] = [];
  return {
    name: "aiui:demo-pages",
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
      if (id.startsWith(ENTRY_PREFIX)) {
        const slug = id.slice(ENTRY_PREFIX.length);
        const demo = demos.find((d) => d.slug === slug);
        if (demo) return demo.entryFile;
      }
      return undefined;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return undefined;
      demos = discover(demosRoot);
      // Watch every candidate's manifest so marker edits regenerate this module.
      for (const d of demos) {
        this.addWatchFile(join(demosRoot, d.slug, "package.json"));
      }
      const rows = demos.map(
        (d) =>
          `  { slug: ${JSON.stringify(d.slug)}, title: ${JSON.stringify(d.title)}, ` +
          `desc: ${JSON.stringify(d.desc)}, order: ${d.order}, ` +
          `load: () => import(${JSON.stringify(ENTRY_PREFIX + d.slug)}) },`,
      );
      return `export const demos = [\n${rows.join("\n")}\n];\n`;
    },
    handleHotUpdate(ctx) {
      // A manifest edit (marker/title/order) restructures the shell: reload.
      if (/[\\/]demos[\\/][^\\/]+[\\/]package\.json$/.test(ctx.file)) {
        const mod = ctx.server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID);
        if (mod) ctx.server.moduleGraph.invalidateModule(mod);
        ctx.server.ws.send({ type: "full-reload" });
        return [];
      }
      return undefined;
    },
  };
}
