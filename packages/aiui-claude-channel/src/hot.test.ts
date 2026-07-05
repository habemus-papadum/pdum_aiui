import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultFormatLoader, type WatchFn, watchChannelSource } from "./hot";
import { defaultFormats } from "./processors";
import { buildReloadableFormats } from "./reloadable";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);

describe("the reloadable lowering layer", () => {
  it("lists the same built-in formats as defaultFormats (drift guard)", async () => {
    // buildReloadableFormats reassembles the registry from freshly-imported
    // format modules, so it must stay in sync with defaultFormats' list.
    const reloadable = await buildReloadableFormats();
    expect([...reloadable.keys()].sort()).toEqual([...defaultFormats().keys()].sort());
  });

  it("defaultFormatLoader builds a distinct registry per generation", async () => {
    const load = defaultFormatLoader();
    const g0 = await load(0);
    const g1 = await load(1);
    // Same formats on offer, but a fresh Map object each generation (the live
    // registry the server swaps in). Deep module-instance freshness is proven by
    // the out-of-harness tsx test below, since a bundler/test runner may cache.
    expect([...g0.keys()].sort()).toEqual([...defaultFormats().keys()].sort());
    expect(g0).not.toBe(g1);
  });
});

describe("loadModuleFresh (query-busted re-import, under the real tsx runner)", () => {
  it("re-imports a module's on-disk content per unique generation, caching per query", () => {
    // Prove the mechanism the way it actually runs: a `node --import tsx` child
    // (how the in-repo CLI is spawned). vitest's own module runner may not honor
    // the `?v=` query, so we don't rely on it here.
    // `.mts` so tsx treats these as ESM (the temp dir has no package.json, whose
    // "type" would otherwise default them to CommonJS and reject top-level await).
    const dir = mkdtempSync(join(tmpdir(), "aiui-hot-"));
    const modulePath = join(dir, "marker.mts");
    const scriptPath = join(dir, "run.mts");
    const hotUrl = pathToFileURL(join(HERE, "hot.ts")).href;
    writeFileSync(
      scriptPath,
      [
        `import { pathToFileURL } from "node:url";`,
        `import { writeFileSync } from "node:fs";`,
        `import { loadModuleFresh } from ${JSON.stringify(hotUrl)};`,
        `const modulePath = process.argv[2];`,
        `const url = pathToFileURL(modulePath).href;`,
        `writeFileSync(modulePath, 'export const value = "v1";\\n');`,
        `const a = await loadModuleFresh(url, 1);`,
        `writeFileSync(modulePath, 'export const value = "v2";\\n');`,
        `const b = await loadModuleFresh(url, 2);`,
        `const c = await loadModuleFresh(url, 1);`,
        `process.stdout.write(JSON.stringify({ a: a.value, b: b.value, c: c.value }));`,
        "",
      ].join("\n"),
    );

    const out = execFileSync(process.execPath, ["--import", "tsx", scriptPath, modulePath], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    });
    // gen 1 saw "v1"; gen 2 (after the file was rewritten) saw the new "v2";
    // gen 1 again is served from cache — same query, same instance.
    expect(JSON.parse(out)).toEqual({ a: "v1", b: "v2", c: "v1" });
  });
});

describe("watchChannelSource", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces a burst of source edits into a single onChange", () => {
    vi.useFakeTimers();
    let listener: ((event: string, filename: string | null) => void) | undefined;
    const close = vi.fn();
    const watch: WatchFn = (_dir, l) => {
      listener = l;
      return { close };
    };
    const onChange = vi.fn();
    const dispose = watchChannelSource({ dir: "/src", onChange, delayMs: 100, watch });

    listener?.("change", "intent-v1.ts");
    listener?.("change", "intent-v1.ts");
    vi.advanceTimersByTime(99);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("ignores non-source and test files", () => {
    vi.useFakeTimers();
    let listener: ((event: string, filename: string | null) => void) | undefined;
    const watch: WatchFn = (_dir, l) => {
      listener = l;
      return { close: () => {} };
    };
    const onChange = vi.fn();
    watchChannelSource({ dir: "/src", onChange, delayMs: 10, watch });

    listener?.("change", "notes.md");
    listener?.("change", "web.test.ts");
    listener?.("change", null);
    vi.advanceTimersByTime(50);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("degrades to a no-op disposer when the watch can't be established", () => {
    const log = vi.fn();
    const dispose = watchChannelSource({
      dir: "/nope",
      onChange: () => {},
      watch: () => {
        throw new Error("recursive watch unsupported");
      },
      log,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("watch unavailable"));
    expect(() => dispose()).not.toThrow();
  });
});
