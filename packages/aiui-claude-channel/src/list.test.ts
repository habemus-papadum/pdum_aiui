import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dirRank, listMcpServers, sortServers } from "./list";
import { type RegistryEntry, registryDir } from "./registry";

function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "0"]);
  if (typeof result.pid !== "number") {
    throw new Error("could not spawn a throwaway process");
  }
  return result.pid;
}

function writeEntry(dir: string, entry: RegistryEntry): string {
  const file = join(dir, `${entry.pid}.json`);
  writeFileSync(file, JSON.stringify(entry));
  return file;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dirRank", () => {
  it("scores same / descendant / outside directories", () => {
    expect(dirRank("/a/b", "/a/b")).toBe(0);
    expect(dirRank("/a/b", "/a/b/c")).toBe(1);
    expect(dirRank("/a/b", "/a/b/c/d")).toBe(2);
    expect(dirRank("/a/b", "/a")).toBe(Number.POSITIVE_INFINITY);
    expect(dirRank("/a/b", "/x/y")).toBe(Number.POSITIVE_INFINITY);
    expect(dirRank("/a/b", "/a/bb")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("sortServers", () => {
  it("orders same dir, then descendants by depth, then outsiders — alpha within", () => {
    const servers = [
      { cwd: "/other/z", pid: 1 },
      { cwd: "/repo/pkg/b", pid: 2 },
      { cwd: "/repo", pid: 3 },
      { cwd: "/repo/pkg/a", pid: 4 },
      { cwd: "/repo/tools", pid: 5 },
      { cwd: "/aaa/early", pid: 6 },
    ];
    expect(sortServers("/repo", servers).map((s) => s.cwd)).toEqual([
      "/repo", // same directory (rank 0)
      "/repo/tools", // depth 1
      "/repo/pkg/a", // depth 2, alpha before pkg/b
      "/repo/pkg/b", // depth 2
      "/aaa/early", // outside, alphabetised
      "/other/z", // outside, alphabetised
    ]);
  });

  it("breaks ties within the same directory by pid", () => {
    const servers = [
      { cwd: "/repo", pid: 30 },
      { cwd: "/repo", pid: 10 },
      { cwd: "/repo", pid: 20 },
    ];
    expect(sortServers("/repo", servers).map((s) => s.pid)).toEqual([10, 20, 30]);
  });

  it("does not mutate its input", () => {
    const servers = [
      { cwd: "/b", pid: 1 },
      { cwd: "/a", pid: 2 },
    ];
    sortServers("/a", servers);
    expect(servers.map((s) => s.cwd)).toEqual(["/b", "/a"]);
  });
});

describe("listMcpServers", () => {
  it("returns only live servers, ranked, and prunes stale files", () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-cache-"));
    vi.stubEnv("AIUI_CACHE", cache);
    const dir = registryDir();

    const live: RegistryEntry = {
      tag: "live-tag",
      pid: process.pid,
      ppid: process.ppid,
      port: 4000,
      cwd: "/repo/pkg",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    const dead: RegistryEntry = {
      tag: "dead-tag",
      pid: deadPid(),
      ppid: 1,
      port: 4001,
      cwd: "/repo",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    writeEntry(dir, live);
    const deadFile = writeEntry(dir, dead);

    const result = listMcpServers("/repo");
    expect(result.map((s) => s.pid)).toEqual([process.pid]);
    expect(result[0].tag).toBe("live-tag");
    expect(result[0].file).toBe(join(dir, `${process.pid}.json`));
    expect(existsSync(deadFile)).toBe(false); // stale file pruned
  });

  it("keeps stale files when prune is disabled", () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-cache-"));
    vi.stubEnv("AIUI_CACHE", cache);
    const dir = registryDir();
    const deadFile = writeEntry(dir, {
      tag: "stale",
      pid: deadPid(),
      ppid: 1,
      port: 4002,
      cwd: "/x",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(listMcpServers("/x", { prune: false })).toEqual([]);
    expect(existsSync(deadFile)).toBe(true);
  });

  it("returns [] and creates nothing when no registry dir exists", () => {
    const cache = join(mkdtempSync(join(tmpdir(), "aiui-cache-")), "fresh");
    vi.stubEnv("AIUI_CACHE", cache);
    expect(listMcpServers("/anywhere")).toEqual([]);
    expect(existsSync(join(cache, "mcp"))).toBe(false);
  });
});
