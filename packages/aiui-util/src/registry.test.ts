import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProcessAlive, readEntry } from "./index";

// A PID that is guaranteed dead: spawn a trivial process and let it exit. Once
// spawnSync returns, the child is gone, so its PID is safe to treat as stale.
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "0"]);
  if (typeof result.pid !== "number") {
    throw new Error("could not spawn a throwaway process");
  }
  return result.pid;
}

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

  it("keeps well-typed optional fields and drops junk ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-reg-"));
    const base = {
      tag: "wb",
      pid: 1,
      ppid: 2,
      port: 3,
      cwd: "/x",
      startedAt: "2026-01-01T00:00:00.000Z",
    };

    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ ...base, name: "aiui debug", debug: true }));
    expect(readEntry(good)).toMatchObject({ tag: "wb", name: "aiui debug", debug: true });

    // Junk in the optional fields is dropped, not fatal — older/foreign writers.
    const junk = join(dir, "junk.json");
    writeFileSync(junk, JSON.stringify({ ...base, name: 42, debug: "yes" }));
    const reread = readEntry(junk);
    expect(reread?.name).toBeUndefined();
    expect(reread?.debug).toBeUndefined();
  });
});
