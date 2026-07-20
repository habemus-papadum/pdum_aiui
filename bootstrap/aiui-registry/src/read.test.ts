import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEntry, scanEntries } from "./read.ts";

let dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "aiui-registry-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

const good = {
  schema: 2,
  tag: "t",
  pid: 1,
  ppid: 2,
  port: 3,
  cwd: "/x",
  startedAt: "2026-07-20T00:00:00.000Z",
  kind: "channel",
};

function write(dir: string, name: string, value: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

describe("readEntry", () => {
  it("accepts a well-formed v2 entry", () => {
    const file = write(tmp(), "1.json", good);
    expect(readEntry(file)).toMatchObject(good);
  });

  it("rejects a v1 entry (no schema field) — no migration shims", () => {
    const { schema: _schema, kind: _kind, ...v1 } = good;
    const file = write(tmp(), "1.json", { ...v1, name: "old", debug: true });
    expect(readEntry(file)).toBeNull();
  });

  it("rejects unknown kinds, bad types, torn JSON, and missing files", () => {
    const dir = tmp();
    expect(readEntry(write(dir, "a.json", { ...good, kind: "nope" }))).toBeNull();
    expect(readEntry(write(dir, "b.json", { ...good, port: "80" }))).toBeNull();
    expect(readEntry(write(dir, "c.json", '{"schema":2,"tag":'))).toBeNull();
    expect(readEntry(join(dir, "missing.json"))).toBeNull();
  });

  it("keeps optional fields only when they are strings", () => {
    const dir = tmp();
    const entry = readEntry(
      write(dir, "1.json", { ...good, assignedName: "n", browserUrl: 7, host: "h" }),
    );
    expect(entry?.assignedName).toBe("n");
    expect(entry?.host).toBe("h");
    expect(entry).not.toHaveProperty("browserUrl");
  });
});

describe("scanEntries", () => {
  it("returns [] for a missing directory", () => {
    expect(scanEntries(join(tmp(), "absent"))).toEqual([]);
  });

  it("collects valid entries, skips malformed ones, ignores non-json", () => {
    const dir = tmp();
    const file = write(dir, "1.json", good);
    write(dir, "2.json", "torn{");
    write(dir, "3.json.900.tmp", "partial");
    write(dir, "notes.txt", "hi");
    const entries = scanEntries(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ...good, file });
  });
});
