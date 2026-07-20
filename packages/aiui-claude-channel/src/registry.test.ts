import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listMcpServers,
  readEntry,
  registerServer,
  registryDir,
  removeEntryFile,
} from "./registry";

// The registry lives in @habemus-papadum/aiui-registry and is tested there.
// What stays here exercises the façade: registerServer round-trips through the
// package, and listMcpServers returns the ENRICHED shape the selectors and
// CLI consume.

/** Isolated cache root with a warm, empty agents cache (no `claude` spawn). */
function freshCacheRoot(): string {
  const cache = mkdtempSync(join(tmpdir(), "aiui-cache-"));
  mkdirSync(join(cache, "agents"), { recursive: true });
  writeFileSync(
    join(cache, "agents", "cache.json"),
    JSON.stringify({ schema: 1, fetchedAt: new Date().toISOString(), status: "ok", agents: [] }),
  );
  return cache;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("removeEntryFile", () => {
  it("does not throw when the file is already gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-reg-"));
    expect(() => removeEntryFile(join(dir, "nope.json"))).not.toThrow();
  });
});

describe("registerServer (via the registry package)", () => {
  it("writes a schema-2 entry that round-trips, and removes it on demand", () => {
    vi.stubEnv("AIUI_CACHE", freshCacheRoot());

    const reg = registerServer({ port: 54321, tag: "abc-123", kind: "channel" });
    expect(reg.entry).toMatchObject({ schema: 2, tag: "abc-123", kind: "channel" });
    expect(reg.file.startsWith(registryDir())).toBe(true);
    expect(readEntry(reg.file)).toEqual(reg.entry);

    reg.remove();
    expect(existsSync(reg.file)).toBe(false);
    expect(() => reg.remove()).not.toThrow();
  });
});

describe("listMcpServers (the enriched façade)", () => {
  it("returns enriched channels — resolvedName present, debug marked via kind", () => {
    vi.stubEnv("AIUI_CACHE", freshCacheRoot());

    const real = registerServer({ port: 1111, tag: "real", kind: "channel" });
    const servers = listMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      tag: "real",
      kind: "channel",
      resolvedName: `pid ${process.ppid}`,
      file: real.file,
    });
  });
});
