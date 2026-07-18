import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readEntry, registerServer, registryDir, removeEntryFile } from "./registry";

// The read side (isProcessAlive, readEntry validation) is single-sourced in
// aiui-util and tested there (aiui-util/src/registry.test.ts). What stays here
// exercises the write side and its use of the re-exported readEntry/registryDir.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("removeEntryFile", () => {
  it("does not throw when the file is already gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-reg-"));
    expect(() => removeEntryFile(join(dir, "nope.json"))).not.toThrow();
  });
});

describe("registerServer", () => {
  it("writes a well-formed entry and removes it (idempotently) on demand", () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-cache-"));
    vi.stubEnv("AIUI_CACHE", cache);

    const reg = registerServer(54321, "abc-123");
    expect(reg.entry.tag).toBe("abc-123");
    expect(reg.entry.pid).toBe(process.pid);
    expect(reg.entry.ppid).toBe(process.ppid);
    expect(reg.entry.port).toBe(54321);
    expect(reg.entry.cwd).toBe(process.cwd());
    expect(reg.file.startsWith(registryDir())).toBe(true);

    expect(readEntry(reg.file)).toEqual(reg.entry);
    expect(existsSync(reg.file)).toBe(true);

    reg.remove();
    expect(existsSync(reg.file)).toBe(false);
    expect(() => reg.remove()).not.toThrow();
  });

  it("round-trips the debug marker and display name (absent by default)", () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-cache-"));
    vi.stubEnv("AIUI_CACHE", cache);

    const plain = registerServer(1111, "real");
    expect(plain.entry.debug).toBeUndefined();
    expect(plain.entry.name).toBeUndefined();
    plain.remove();

    const dbg = registerServer(2222, "wb", { debug: true, name: "aiui debug" });
    expect(readEntry(dbg.file)).toEqual(dbg.entry);
    expect(dbg.entry).toMatchObject({ tag: "wb", debug: true, name: "aiui debug" });

    // Junk in the optional fields is dropped, not fatal — older/foreign writers.
    writeFileSync(dbg.file, JSON.stringify({ ...dbg.entry, name: 42, debug: "yes" }));
    const reread = readEntry(dbg.file);
    expect(reread?.name).toBeUndefined();
    expect(reread?.debug).toBeUndefined();
  });
});
