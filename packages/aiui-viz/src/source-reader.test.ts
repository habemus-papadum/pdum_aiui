import { describe, expect, it } from "vitest";
import type { AiuiGlobal } from "./aiui-global";
import {
  joinSourcePath,
  listSources,
  readSource,
  SourceUnavailableError,
  sourcesMode,
  sourceText,
  suggestSources,
} from "./source-reader";

const FILE = ["line one", "line two", "line three", "line four"].join("\n");

const fakeFetch = (routes: Record<string, unknown>): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    const hit = routes[url];
    return {
      ok: hit !== undefined,
      status: hit === undefined ? 404 : 200,
      json: async () => hit,
      text: async () => String(hit),
    } as Response;
  }) as typeof fetch;

describe("joinSourcePath", () => {
  it("resolves dotdot and dot segments against the root", () => {
    expect(joinSourcePath("/repo/demos/gallery", "src/main.tsx")).toBe(
      "/repo/demos/gallery/src/main.tsx",
    );
    expect(joinSourcePath("/repo/demos/gallery/", "../seismos/src/ui/App.tsx")).toBe(
      "/repo/demos/seismos/src/ui/App.tsx",
    );
    expect(joinSourcePath("/r", "../../../x")).toBe("/x");
  });
});

describe("suggestSources", () => {
  const files = ["src/main.tsx", "src/ui/App.tsx", "../seismos/src/ui/App.tsx", "src/ui/app.css"];
  it("ranks same basename, then paths containing it, then the asked directory", () => {
    expect(suggestSources("ui/App.tsx", files)).toEqual([
      "src/ui/App.tsx",
      "../seismos/src/ui/App.tsx",
      "src/ui/app.css",
    ]);
    expect(suggestSources("src/nope.ts", files)).toEqual([
      "src/main.tsx",
      "src/ui/App.tsx",
      "../seismos/src/ui/App.tsx",
      "src/ui/app.css",
    ]);
    expect(suggestSources("zzz", [])).toEqual([]);
  });
});

describe("sourcesMode", () => {
  it("reads the seeds: dev by the dev manifest or a machine root, shipped by a manifest, else none", () => {
    expect(sourcesMode({ v: 1 })).toBe("none");
    expect(sourcesMode({ v: 1, sourceRoot: "https://example.test/" })).toBe("none");
    expect(sourcesMode({ v: 1, sourceRoot: "/repo/app" })).toBe("dev");
    expect(
      sourcesMode({ v: 1, sources: { base: "/", manifest: "/__aiui/sources.json", mode: "dev" } }),
    ).toBe("dev");
    expect(
      sourcesMode({
        v: 1,
        sourceRoot: "https://github.com/x/y/blob/main/",
        sources: { base: "/aiui/", manifest: "/aiui/__aiui/sources.json" },
      }),
    ).toBe("shipped");
  });
});

describe("readSource on a dev server", () => {
  const listed: AiuiGlobal = {
    v: 1,
    sourceRoot: "/repo/demos/gallery",
    sources: { base: "/", manifest: "/__aiui/sources.json", mode: "dev" },
  };
  const fetchImpl = fakeFetch({
    "/__aiui/sources.json": {
      files: {
        "src/main.tsx": "/@fs/repo/demos/gallery/src/main.tsx",
        "../seismos/src/ui/App.tsx": "/@fs/repo/demos/seismos/src/ui/App.tsx",
      },
    },
  });

  it("imports the listed file as a raw string module at its /@fs URL and numbers the lines", async () => {
    const urls: string[] = [];
    const out = await readSource(
      "../seismos/src/ui/App.tsx",
      {},
      {
        global: listed,
        fetchImpl,
        importRaw: async (url) => {
          urls.push(url);
          return { default: `${FILE}\n` };
        },
      },
    );
    expect(urls).toEqual(["/@fs/repo/demos/seismos/src/ui/App.tsx?raw"]);
    expect(out).toEqual({
      file: "../seismos/src/ui/App.tsx",
      from: 1,
      to: 4,
      total: 4,
      more: false,
      text: "1 | line one\n2 | line two\n3 | line three\n4 | line four",
    });
    expect(await listSources({ global: listed, fetchImpl })).toEqual({
      mode: "dev",
      files: ["../seismos/src/ui/App.tsx", "src/main.tsx"],
    });
  });

  it("says when a file is not among the listed ones, with the nearest names", async () => {
    const err = await readSource("src/ui/App.tsx", {}, { global: listed, fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect(err as SourceUnavailableError).toMatchObject({
      file: "src/ui/App.tsx",
      reason:
        'no source "src/ui/App.tsx" among the 2 files this page lists — call sources to see them',
      suggestions: ["../seismos/src/ui/App.tsx"],
    });
  });

  it("falls back to joining the machine root when the plugin lists nothing (older seed)", async () => {
    const global: AiuiGlobal = { v: 1, sourceRoot: "/repo/demos/gallery" };
    const urls: string[] = [];
    await sourceText("src/a.ts", {
      global,
      importRaw: async (url) => {
        urls.push(url);
        return FILE;
      },
    });
    expect(urls).toEqual(["/@fs/repo/demos/gallery/src/a.ts?raw"]);
    expect(await listSources({ global })).toMatchObject({ mode: "dev", note: /lists no files/ });
    const err = await sourceText("src/gone.ts", {
      global,
      importRaw: async () => {
        throw new Error("404");
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toMatch(/does not serve "src\/gone.ts" \(404\)/);
  });

  it("windows by from/to and stops early at maxChars, saying so with `to` and `more`", async () => {
    const global: AiuiGlobal = { v: 1, sourceRoot: "/repo/demos/gallery" };
    const deps = { global, importRaw: async () => FILE };
    expect(await readSource("a.ts", { from: 2, to: 3 }, deps)).toMatchObject({
      from: 2,
      to: 3,
      more: true,
      text: "2 | line two\n3 | line three",
    });
    expect(await readSource("a.ts", { from: 9 }, deps)).toMatchObject({ from: 4, to: 4 });
    expect(await readSource("a.ts", { maxChars: 26 }, deps)).toMatchObject({
      from: 1,
      to: 2,
      more: true,
    });
  });

  it("rejects names that are not stamp paths", async () => {
    const deps = { global: listed, importRaw: async () => FILE };
    await expect(readSource("", {}, deps)).rejects.toThrow(/not a stamp path/);
    await expect(readSource("/etc/passwd", {}, deps)).rejects.toThrow(/not a stamp path/);
    await expect(readSource("https://x/y.ts", {}, deps)).rejects.toThrow(/not a stamp path/);
  });
});

describe("readSource on a shipped build", () => {
  const global = {
    v: 1,
    sourceRoot: "https://github.com/x/y/blob/main/demos/gallery/",
    sources: { base: "/aiui/", manifest: "/aiui/__aiui/sources.json" },
  } as AiuiGlobal;
  const fetchImpl = fakeFetch({
    "/aiui/__aiui/sources.json": {
      files: { "src/main.tsx": "__aiui/src/src/main.tsx" },
    },
    "/aiui/__aiui/src/src/main.tsx": FILE,
  });

  it("reads through the manifest and lists what shipped", async () => {
    const out = await readSource("src/main.tsx", { to: 1 }, { global, fetchImpl });
    expect(out).toMatchObject({ from: 1, to: 1, total: 4, more: true, text: "1 | line one" });
    expect(await listSources({ global, fetchImpl })).toEqual({
      mode: "shipped",
      files: ["src/main.tsx"],
    });
    const err = await readSource("src/nope.ts", {}, { global, fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toMatch(
      /no source "src\/nope.ts" among the 1 files/,
    );
  });
});

describe("readSource elsewhere", () => {
  it("says the page carries no source, as an unavailable answer", async () => {
    const err = await readSource("src/a.ts", {}, { global: { v: 1 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toMatch(/carries no source/);
    expect(await listSources({ global: { v: 1 } })).toMatchObject({
      mode: "none",
      files: [],
      note: /carries no source/,
    });
  });
});
