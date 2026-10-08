import { describe, expect, it } from "vitest";
import type { AiuiGlobal } from "./aiui-global";
import { joinSourcePath, listShippedSources, readSource } from "./source-reader";

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

describe("readSource on a dev server", () => {
  const global: AiuiGlobal = { v: 1, sourceRoot: "/repo/demos/gallery" };

  it("imports the file as a raw string module through /@fs and numbers the lines", async () => {
    const urls: string[] = [];
    const out = await readSource(
      "../seismos/src/ui/App.tsx",
      {},
      {
        global,
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
  });

  it("windows by from/to and stops early at maxChars, saying so with `to` and `more`", async () => {
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
    expect(await listShippedSources({ global })).toBeUndefined();
  });

  it("rejects names that are not stamp paths", async () => {
    const deps = { global, importRaw: async () => FILE };
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
    expect(await listShippedSources({ global, fetchImpl })).toEqual(["src/main.tsx"]);
    await expect(readSource("src/nope.ts", {}, { global, fetchImpl })).rejects.toThrow(
      /no shipped source "src\/nope.ts" — the build lists 1 files/,
    );
  });
});

describe("readSource elsewhere", () => {
  it("says the page carries no source", async () => {
    await expect(readSource("src/a.ts", {}, { global: { v: 1 } })).rejects.toThrow(
      /carries no source/,
    );
    await expect(
      readSource("src/a.ts", {}, { global: { v: 1, sourceRoot: "https://example.test/" } }),
    ).rejects.toThrow(/carries no source/);
  });
});
