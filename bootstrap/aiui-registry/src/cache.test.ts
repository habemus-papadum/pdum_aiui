import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentsFetchResult } from "./agents.ts";
import { cachedAgents } from "./cache.ts";
import type { ClaudeAgent } from "./types.ts";

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

const agent: ClaudeAgent = {
  pid: 42,
  cwd: "/w",
  kind: "interactive",
  startedAt: 1,
  sessionId: "s",
  name: "session-a",
  status: "idle",
};

function okFetch(agents: ClaudeAgent[], counter: { calls: number }) {
  return (): AgentsFetchResult => {
    counter.calls++;
    return { status: "ok", agents, claudePath: "/fake/claude" };
  };
}

function writeCache(dir: string, fetchedAtMs: number, agents: ClaudeAgent[]): void {
  writeFileSync(
    join(dir, "cache.json"),
    JSON.stringify({
      schema: 1,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      status: "ok",
      claudePath: "/cached/claude",
      agents,
    }),
  );
}

describe("cachedAgents", () => {
  it("rejects bad client names", () => {
    expect(() => cachedAgents({ client: "Not Valid!", dir: tmp() })).toThrow(/invalid client/);
  });

  it("serves a fresh cache without fetching", () => {
    const dir = tmp();
    const now = Date.now();
    writeCache(dir, now - 1000, [agent]);
    const counter = { calls: 0 };
    const result = cachedAgents({
      client: "test",
      dir,
      now: () => now,
      fetch: okFetch([], counter),
    });
    expect(counter.calls).toBe(0);
    expect(result.agents).toEqual([agent]);
    expect(result.info.status).toBe("ok");
    expect(result.info.claudePath).toBe("/cached/claude");
  });

  it("refetches a stale cache and rewrites it", () => {
    const dir = tmp();
    const now = Date.now();
    writeCache(dir, now - 10_000, []);
    const counter = { calls: 0 };
    const result = cachedAgents({
      client: "test",
      dir,
      now: () => now,
      fetch: okFetch([agent], counter),
    });
    expect(counter.calls).toBe(1);
    expect(result.agents).toEqual([agent]);
    const onDisk = JSON.parse(readFileSync(join(dir, "cache.json"), "utf8"));
    expect(onDisk.fetchedAt).toBe(new Date(now).toISOString());
    expect(existsSync(join(dir, "test.lock"))).toBe(false); // released
  });

  it("fetches cold (no cache) and records a claude-missing verdict loudly", () => {
    const dir = tmp();
    const result = cachedAgents({
      client: "test",
      dir,
      fetch: () => ({
        status: "claude-missing",
        agents: [],
        claudePath: "/gone/claude",
      }),
    });
    expect(result.info.status).toBe("claude-missing");
    expect(result.info.claudePath).toBe("/gone/claude");
    const onDisk = JSON.parse(readFileSync(join(dir, "cache.json"), "utf8"));
    expect(onDisk.status).toBe("claude-missing");
  });

  it("serves the stale cache when another client class holds a fresh lock", () => {
    const dir = tmp();
    const now = Date.now();
    writeCache(dir, now - 10_000, [agent]);
    writeFileSync(join(dir, "test.lock"), "123");
    const counter = { calls: 0 };
    const result = cachedAgents({
      client: "test",
      dir,
      now: () => now,
      fetch: okFetch([], counter),
    });
    expect(counter.calls).toBe(0);
    expect(result.agents).toEqual([agent]); // stale-while-revalidate
  });

  it("breaks a lock older than the max age and refreshes", () => {
    const dir = tmp();
    const now = Date.now();
    writeCache(dir, now - 10_000, []);
    const lock = join(dir, "test.lock");
    writeFileSync(lock, "123");
    const old = (now - 60_000) / 1000;
    utimesSync(lock, old, old);
    const counter = { calls: 0 };
    const result = cachedAgents({
      client: "test",
      dir,
      now: () => now,
      fetch: okFetch([agent], counter),
    });
    expect(counter.calls).toBe(1);
    expect(result.agents).toEqual([agent]);
    expect(existsSync(lock)).toBe(false);
  });

  it("fetches anyway on a cold start even when the lock is held (dedup is best-effort)", () => {
    const dir = tmp();
    writeFileSync(join(dir, "test.lock"), "123");
    const counter = { calls: 0 };
    const result = cachedAgents({ client: "test", dir, fetch: okFetch([agent], counter) });
    expect(counter.calls).toBe(1);
    expect(result.agents).toEqual([agent]);
  });

  it("treats a malformed cache file as absent", () => {
    const dir = tmp();
    writeFileSync(join(dir, "cache.json"), "torn{");
    const counter = { calls: 0 };
    const result = cachedAgents({ client: "test", dir, fetch: okFetch([agent], counter) });
    expect(counter.calls).toBe(1);
    expect(result.agents).toEqual([agent]);
  });
});
