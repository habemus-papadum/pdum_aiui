/**
 * The ship-sources plugin: the app's own files (root + stamp roots, never
 * node_modules or libraries) are emitted unchanged under __aiui/src/ with a
 * manifest keyed by the STAMP path, and the page learns the base + manifest.
 */
import { describe, expect, it } from "vitest";
import { SOURCES_MANIFEST, shippedPath, shipSources } from "./ship-sources.ts";

type Hook<T> = (...args: never[]) => T;

function configured(read: (file: string) => string) {
  const plugin = shipSources({ roots: ["/repo/demos"], read });
  (plugin.configResolved as unknown as (c: unknown) => void)({
    command: "build",
    base: "/aiui/",
    root: "/repo/demos/gallery",
  });
  const transform = plugin.transform as unknown as (code: string, id: string) => null;
  return { plugin, transform };
}

describe("shippedPath", () => {
  it("keeps in-root paths and turns dotdot segments into up/", () => {
    expect(shippedPath("src/main.tsx")).toBe("__aiui/src/src/main.tsx");
    expect(shippedPath("../seismos/src/ui/App.tsx")).toBe("__aiui/src/up/seismos/src/ui/App.tsx");
    expect(shippedPath("../../x/y.css")).toBe("__aiui/src/up/up/x/y.css");
  });
});

describe("shipSources", () => {
  it("emits the app's files (root and stamp roots) with a stamp-keyed manifest", () => {
    const reads: string[] = [];
    const { plugin, transform } = configured((file) => {
      reads.push(file);
      return `// ${file}`;
    });
    transform("x", "/repo/demos/gallery/src/main.tsx");
    transform("x", "/repo/demos/gallery/src/main.tsx?v=2"); // a query is the same file
    transform("x", "/repo/demos/seismos/src/ui/App.tsx");
    transform("x", "/repo/demos/seismos/src/page.css");
    transform("x", "/repo/packages/viz/src/cell.ts"); // a library: not ours
    transform("x", "/repo/demos/gallery/node_modules/x/index.js");
    transform("x", "/repo/demos/gallery/src/logo.png"); // not source
    transform("x", "\0virtual:demo-pages"); // not a file
    const emitted: Array<{ fileName: string; source: string }> = [];
    (plugin.generateBundle as unknown as Hook<void>).call({
      emitFile: (f: { fileName: string; source: string }) => emitted.push(f),
    });
    expect(emitted.map((f) => f.fileName)).toEqual([
      "__aiui/src/up/seismos/src/page.css",
      "__aiui/src/up/seismos/src/ui/App.tsx",
      "__aiui/src/src/main.tsx",
      SOURCES_MANIFEST,
    ]);
    expect(emitted[2]?.source).toBe("// /repo/demos/gallery/src/main.tsx");
    expect(JSON.parse(emitted[3]?.source ?? "")).toEqual({
      files: {
        "../seismos/src/page.css": "__aiui/src/up/seismos/src/page.css",
        "../seismos/src/ui/App.tsx": "__aiui/src/up/seismos/src/ui/App.tsx",
        "src/main.tsx": "__aiui/src/src/main.tsx",
      },
    });
    expect(reads).toHaveLength(3);
  });

  it("tells the page where the manifest is, under the app's base", () => {
    const { plugin } = configured(() => "");
    const tags = (plugin.transformIndexHtml as unknown as Hook<Array<{ children: string }>>)();
    expect(tags[0]?.children).toBe(
      '(window.__AIUI__ ??= { v: 1 }).sources = {"base":"/aiui/","manifest":"/aiui/__aiui/sources.json"};',
    );
  });

  it("is a build-only plugin", () => {
    expect(shipSources().apply).toBe("build");
  });
});
