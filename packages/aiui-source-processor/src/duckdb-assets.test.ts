/**
 * The duckdb-assets plugin: the installed duckdb-wasm is located through the
 * consumer's own dependency graph, the page learns `{ prefix, version }` in
 * serve AND build, dev serves the four files at the MotherDuck layout with
 * immutable caching, and the build emits them unhashed (plus `.br` on request).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  DUCKDB_ASSET_FILES,
  type DuckdbAssetsLayout,
  duckdbAssetPath,
  duckdbAssets,
  locateDuckdbAssets,
} from "./duckdb-assets.ts";

/** A tiny fake dist so the build test never compresses 36 MB. */
function fakeLayout(): DuckdbAssetsLayout {
  const distDir = mkdtempSync(join(tmpdir(), "duckdb-assets-"));
  for (const file of DUCKDB_ASSET_FILES) {
    writeFileSync(join(distDir, file), `fake ${file} `.repeat(50));
  }
  return { version: "9.9.9-test.0", distDir };
}

type Hook<T> = (...args: never[]) => T;

function configure(plugin: ReturnType<typeof duckdbAssets>, base: string) {
  (plugin.configResolved as unknown as (c: unknown) => void)({ command: "build", base, root: "/" });
}

describe("locateDuckdbAssets", () => {
  it("finds the consumer's installed duckdb-wasm and its version", () => {
    // aiui-viz declares duckdb-wasm; this package does not — the resolution
    // walks the CONSUMER's graph, which is the point.
    const vizDir = fileURLToPath(new URL("../../aiui-viz", import.meta.url));
    const layout = locateDuckdbAssets(vizDir);
    expect(layout.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(layout.distDir).toMatch(/duckdb-wasm[/\\]dist$/);
  });
});

describe("duckdbAssets", () => {
  it("tells the page the prefix and version, in every mode", async () => {
    const plugin = duckdbAssets({ layout: fakeLayout() });
    configure(plugin, "/notes/x/");
    const tags = await (
      plugin.transformIndexHtml as unknown as Hook<Promise<Array<{ children: string }>>>
    )();
    expect(tags[0]?.children).toBe(
      '(window.__AIUI__ ??= { v: 1 }).duckdbAssets = {"prefix":"/notes/x/","version":"9.9.9-test.0"};',
    );
  });

  it("serves the four files at the MotherDuck layout, immutable, and ignores the rest", async () => {
    const layout = fakeLayout();
    const plugin = duckdbAssets({ layout });
    configure(plugin, "/notes/x/");
    let handler: ((req: unknown, res: unknown, next: () => void) => void) | undefined;
    (plugin.configureServer as unknown as (s: unknown) => void)({
      middlewares: { use: (fn: typeof handler) => (handler = fn) },
    });
    const call = (url: string) => {
      const headers: Record<string, string> = {};
      let body: Buffer | undefined;
      let nexted = false;
      handler?.(
        { url },
        {
          setHeader: (k: string, v: string) => (headers[k] = v),
          end: (b: Buffer) => (body = b),
        },
        () => (nexted = true),
      );
      return { headers, body, nexted };
    };
    const withBase = call(`/notes/x/${duckdbAssetPath(layout.version, "duckdb-eh.wasm")}?v=1`);
    expect(withBase.nexted).toBe(false);
    expect(withBase.headers["Content-Type"]).toBe("application/wasm");
    expect(withBase.headers["Cache-Control"]).toContain("immutable");
    expect(withBase.body?.toString()).toContain("fake duckdb-eh.wasm");

    const stripped = call(`/${duckdbAssetPath(layout.version, "duckdb-browser-eh.worker.js")}`);
    expect(stripped.headers["Content-Type"]).toBe("text/javascript");

    expect(call("/notes/x/index.html").nexted).toBe(true);
    expect(call(`/${duckdbAssetPath("0.0.0", "duckdb-eh.wasm")}`).nexted).toBe(true);
  });

  it("emits the files unhashed into the build, with .br siblings on request", () => {
    const layout = fakeLayout();
    const emitted: Array<{ fileName: string; source: Buffer }> = [];
    const ctx = { emitFile: (f: { fileName: string; source: Buffer }) => emitted.push(f) };

    const plain = duckdbAssets({ layout });
    configure(plain, "/");
    (plain.generateBundle as unknown as Hook<void>).call(ctx);
    expect(emitted.map((e) => e.fileName)).toEqual(
      DUCKDB_ASSET_FILES.map((f) => `duckdb-wasm-assets/9.9.9-test.0/${f}`),
    );

    emitted.length = 0;
    const br = duckdbAssets({ layout, brotli: true });
    configure(br, "/");
    (br.generateBundle as unknown as Hook<void>).call(ctx);
    expect(emitted).toHaveLength(8);
    const wasm = emitted.find((e) => e.fileName.endsWith("duckdb-eh.wasm"));
    const packed = emitted.find((e) => e.fileName.endsWith("duckdb-eh.wasm.br"));
    expect(packed && brotliDecompressSync(packed.source).equals(wasm?.source as Buffer)).toBe(true);
  });
});
