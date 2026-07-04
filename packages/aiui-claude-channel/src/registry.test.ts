import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isProcessAlive,
  readEntry,
  registerServer,
  registryDir,
  removeEntryFile,
} from "./registry";

// A PID that is guaranteed dead: spawn a trivial process and let it exit. Once
// spawnSync returns, the child is gone, so its PID is safe to treat as stale.
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "0"]);
  if (typeof result.pid !== "number") {
    throw new Error("could not spawn a throwaway process");
  }
  return result.pid;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isProcessAlive", () => {
  it("is true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("is false for a process that has exited", () => {
    expect(isProcessAlive(deadPid())).toBe(false);
  });

  it("is false for nonsensical pids", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });
});

describe("removeEntryFile", () => {
  it("does not throw when the file is already gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-reg-"));
    expect(() => removeEntryFile(join(dir, "nope.json"))).not.toThrow();
  });
});

describe("readEntry", () => {
  it("returns null for malformed or non-conforming files", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-reg-"));

    const notJson = join(dir, "a.json");
    writeFileSync(notJson, "{not json");
    expect(readEntry(notJson)).toBeNull();

    const wrongShape = join(dir, "b.json");
    writeFileSync(wrongShape, JSON.stringify({ pid: "x" }));
    expect(readEntry(wrongShape)).toBeNull();

    // Valid but for a missing tag — still rejected.
    const noTag = join(dir, "c.json");
    writeFileSync(
      noTag,
      JSON.stringify({
        pid: 1,
        ppid: 2,
        port: 3,
        cwd: "/x",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(readEntry(noTag)).toBeNull();

    expect(readEntry(join(dir, "missing.json"))).toBeNull();
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
});
