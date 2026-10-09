/**
 * The dev-sources plugin: the workspace walk (root + stamp roots, the skips),
 * the manifest route under the base, and the dev seed.
 */
import { describe, expect, it } from "vitest";
import { devSources, listSourceFiles, type ReadDir } from "./dev-sources.ts";
import { SOURCES_MANIFEST } from "./ship-sources.ts";

/** A fake tree: directory → entries (a trailing slash marks a directory). */
function fakeFs(tree: Record<string, string[]>): ReadDir {
  return (dir) => {
    const entries = tree[dir];
    if (entries === undefined) throw new Error(`ENOENT ${dir}`);
    return entries.map((name) => ({
      name: name.replace(/\/$/, ""),
      isDirectory: () => name.endsWith("/"),
      isFile: () => !name.endsWith("/"),
    }));
  };
}

const TREE: Record<string, string[]> = {
  "/repo/demos/gallery": [
    "src/",
    "node_modules/",
    "dist/",
    ".aiui-cache/",
    "index.html",
    "vite.config.ts",
  ],
  "/repo/demos/gallery/src": ["main.tsx", "site/", "logo.png"],
  "/repo/demos/gallery/src/site": ["Landing.tsx", "site.css"],
  "/repo/demos/gallery/node_modules": ["x/"],
  "/repo/demos/gallery/dist": ["index.js"],
  "/repo/demos/gallery/.aiui-cache": ["trace.json"],
  "/repo/demos": ["gallery/", "seismos/"],
  "/repo/demos/seismos": ["src/", "README.md"],
  "/repo/demos/seismos/src": ["ui/", "data.json"],
  "/repo/demos/seismos/src/ui": ["App.tsx"],
};

describe("listSourceFiles", () => {
  it("walks the root and the stamp roots, skipping node_modules, dist and dot-dirs, keyed by stamp path", () => {
    const files = listSourceFiles("/repo/demos/gallery", ["/repo/demos"], fakeFs(TREE));
    expect(files).toEqual({
      "../seismos/README.md": "/@fs/repo/demos/seismos/README.md",
      "../seismos/src/data.json": "/@fs/repo/demos/seismos/src/data.json",
      "../seismos/src/ui/App.tsx": "/@fs/repo/demos/seismos/src/ui/App.tsx",
      "src/main.tsx": "/@fs/repo/demos/gallery/src/main.tsx",
      "src/site/Landing.tsx": "/@fs/repo/demos/gallery/src/site/Landing.tsx",
      "src/site/site.css": "/@fs/repo/demos/gallery/src/site/site.css",
      "vite.config.ts": "/@fs/repo/demos/gallery/vite.config.ts",
    });
  });

  it("lists nothing for a root that is not there", () => {
    expect(listSourceFiles("/nope", [], fakeFs(TREE))).toEqual({});
  });
});

describe("devSources", () => {
  function configured(base: string) {
    const plugin = devSources({ roots: ["/repo/demos"], readDir: fakeFs(TREE) });
    (plugin.configResolved as unknown as (c: unknown) => void)({
      command: "serve",
      base,
      root: "/repo/demos/gallery",
    });
    let handler: ((req: unknown, res: unknown, next: () => void) => void) | undefined;
    (plugin.configureServer as unknown as (s: unknown) => void)({
      middlewares: { use: (fn: typeof handler) => (handler = fn) },
    });
    const call = (url: string) => {
      const headers: Record<string, string> = {};
      let body: string | undefined;
      let nexted = false;
      handler?.(
        { url },
        {
          setHeader: (k: string, v: string) => (headers[k] = v),
          end: (b: string) => (body = b),
        },
        () => (nexted = true),
      );
      return { headers, body, nexted };
    };
    return { plugin, call };
  }

  it("is serve-only and seeds the page with the manifest's URL and mode dev", () => {
    const { plugin } = configured("/notes/x/");
    expect(plugin.apply).toBe("serve");
    const tags = (plugin.transformIndexHtml as unknown as () => Array<{ children: string }>)();
    expect(tags[0]?.children).toBe(
      '(window.__AIUI__ ??= { v: 1 }).sources = {"base":"/notes/x/","manifest":"/notes/x/__aiui/sources.json","mode":"dev"};',
    );
  });

  it("answers the manifest route (with or without the base), uncached, and ignores the rest", () => {
    const { call } = configured("/notes/x/");
    const withBase = call(`/notes/x/${SOURCES_MANIFEST}?t=1`);
    expect(withBase.nexted).toBe(false);
    expect(withBase.headers["Content-Type"]).toBe("application/json");
    expect(withBase.headers["Cache-Control"]).toBe("no-store");
    const parsed = JSON.parse(withBase.body ?? "") as { files: Record<string, string> };
    expect(Object.keys(parsed.files)).toContain("../seismos/src/ui/App.tsx");
    expect(parsed.files["src/main.tsx"]).toBe("/@fs/repo/demos/gallery/src/main.tsx");
    expect(call(`/${SOURCES_MANIFEST}`).nexted).toBe(false);
    expect(call("/notes/x/index.html").nexted).toBe(true);
  });
});
