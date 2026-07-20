import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEntry as readEntryV2 } from "@habemus-papadum/aiui-registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readEntry, registerServer, registryDir, removeEntryFile } from "./registry";

// The write side is single-sourced in @habemus-papadum/aiui-registry (schema
// v2) and tested there. What stays here exercises the façade: the re-exported
// registerServer writes entries that (a) the registry package round-trips and
// (b) the v1 reader still ACCEPTS during the M3→M4 transition — v2's required
// fields are a superset, so old readers keep listing new servers (only the
// display extras `name`/`debug` are gone until M4's enriched listing).

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
  it("writes a schema-2 channel entry and removes it (idempotently) on demand", () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-cache-"));
    vi.stubEnv("AIUI_CACHE", cache);

    const reg = registerServer({ port: 54321, tag: "abc-123", kind: "channel" });
    expect(reg.entry).toMatchObject({
      schema: 2,
      tag: "abc-123",
      pid: process.pid,
      ppid: process.ppid,
      port: 54321,
      cwd: process.cwd(),
      kind: "channel",
    });
    expect(reg.file.startsWith(registryDir())).toBe(true);
    expect(readEntryV2(reg.file)).toEqual(reg.entry);

    reg.remove();
    expect(existsSync(reg.file)).toBe(false);
    expect(() => reg.remove()).not.toThrow();
  });

  it("v2 entries stay readable by the v1 reader (transition guarantee)", () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-cache-"));
    vi.stubEnv("AIUI_CACHE", cache);

    const dbg = registerServer({
      port: 2222,
      tag: "wb",
      kind: "debug",
      assignedName: "aiui debug",
      browserUrl: "http://127.0.0.1:9222",
    });
    const v1 = readEntry(dbg.file);
    expect(v1).toMatchObject({ tag: "wb", port: 2222, pid: process.pid });
    // The v1 reader drops what it doesn't know — display degrades, listing works.
    expect(v1?.name).toBeUndefined();
    expect(v1?.debug).toBeUndefined();
    dbg.remove();
  });
});
