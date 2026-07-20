import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentsFetchResult } from "./agents.ts";
import { listChannels, resolveName } from "./list.ts";
import type { ClaudeAgent, RegistryEntry, SessionInfo } from "./types.ts";
import { registerServer } from "./write.ts";

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

const sessionAgent: ClaudeAgent = {
  pid: 424242,
  cwd: "/w",
  kind: "interactive",
  startedAt: 5,
  sessionId: "sess-1",
  name: "pdum-aiui-97",
  status: "idle",
};

const okFetch = (agents: ClaudeAgent[]) => (): AgentsFetchResult => ({
  status: "ok",
  agents,
  claudePath: "/fake/claude",
});

function opts(registry: string, agents: string, extra: Record<string, unknown> = {}) {
  return {
    client: "test",
    registryDir: registry,
    agentsDir: agents,
    fetch: okFetch([sessionAgent]),
    ...extra,
  };
}

describe("listChannels", () => {
  it("returns enriched channels with protocol, session join, and loud agents status", () => {
    const registry = tmp();
    registerServer({
      port: 7001,
      tag: "t1",
      kind: "channel",
      ppid: sessionAgent.pid,
      registryDir: registry,
      browserUrl: "http://127.0.0.1:9222",
    });
    const listing = listChannels(opts(registry, tmp()));
    expect(listing.protocol).toBe(2);
    expect(listing.agents.status).toBe("ok");
    expect(listing.channels).toHaveLength(1);
    const [ch] = listing.channels;
    expect(ch.session?.sessionId).toBe("sess-1");
    expect(ch.resolvedName).toBe("pdum-aiui-97");
    expect(ch.browserUrl).toBe("http://127.0.0.1:9222");
  });

  it("prunes dead entries and recycled pids, keeps live ones", () => {
    const registry = tmp();
    // Live: this process, registered "now" — OS start predates registration.
    const live = registerServer({ port: 1, tag: "live", kind: "channel", registryDir: registry });
    // Dead: a pid far beyond any real process.
    const dead = registerServer({
      port: 2,
      tag: "dead",
      kind: "channel",
      pid: 9_999_992,
      registryDir: registry,
    });
    // Recycled: the (alive) vitest parent, "registered" in 1970 — its OS start
    // time postdates the registration, so the pid must have been reassigned.
    const recycled = registerServer({
      port: 3,
      tag: "recycled",
      kind: "channel",
      pid: process.ppid,
      startedAt: "1970-01-02T00:00:00.000Z",
      registryDir: registry,
    });
    const listing = listChannels(opts(registry, tmp()));
    expect(listing.channels.map((c) => c.tag)).toEqual(["live"]);
    expect(existsSync(live.file)).toBe(true);
    expect(existsSync(dead.file)).toBe(false);
    expect(existsSync(recycled.file)).toBe(false);
  });

  it("respects prune: false", () => {
    const registry = tmp();
    const dead = registerServer({
      port: 2,
      tag: "dead",
      kind: "channel",
      pid: 9_999_992,
      registryDir: registry,
    });
    const listing = listChannels(opts(registry, tmp(), { prune: false }));
    expect(listing.channels).toHaveLength(0);
    expect(existsSync(dead.file)).toBe(true);
  });

  it("does not join sessions for debug or remote entries", () => {
    const registry = tmp();
    registerServer({
      port: 1,
      tag: "dbg",
      kind: "debug",
      assignedName: "test bench",
      ppid: sessionAgent.pid, // would wrongly join if the kind guard were missing
      registryDir: registry,
    });
    const listing = listChannels(opts(registry, tmp()));
    expect(listing.channels[0].session).toBeUndefined();
    expect(listing.channels[0].resolvedName).toBe("test bench");
  });

  it("ranks by directory affinity to baseDir", () => {
    const registry = tmp();
    // Two live pids: this process (cwd /zzz) and the vitest parent (cwd /aaa).
    registerServer({ port: 1, tag: "here", kind: "channel", cwd: "/zzz", registryDir: registry });
    registerServer({
      port: 2,
      tag: "elsewhere",
      kind: "channel",
      cwd: "/aaa",
      pid: process.ppid,
      registryDir: registry,
    });
    const listing = listChannels(opts(registry, tmp(), { baseDir: "/zzz" }));
    expect(listing.channels.map((c) => c.tag)).toEqual(["here", "elsewhere"]);
  });

  it("surfaces a claude-missing fetch loudly while still listing channels", () => {
    const registry = tmp();
    registerServer({ port: 1, tag: "t", kind: "channel", registryDir: registry });
    const listing = listChannels(
      opts(registry, tmp(), {
        fetch: (): AgentsFetchResult => ({
          status: "claude-missing",
          agents: [],
          claudePath: "/gone/claude",
        }),
      }),
    );
    expect(listing.agents.status).toBe("claude-missing");
    expect(listing.agents.claudePath).toBe("/gone/claude");
    expect(listing.channels).toHaveLength(1);
    expect(listing.channels[0].resolvedName).toBe(`pid ${process.ppid}`);
  });
});

describe("resolveName", () => {
  const base: RegistryEntry = {
    schema: 2,
    tag: "t",
    pid: 1,
    ppid: 77,
    port: 1,
    cwd: "/",
    startedAt: "2026-01-01T00:00:00.000Z",
    kind: "channel",
  };
  const session: SessionInfo = {
    sessionId: "s",
    name: "live-name",
    status: "idle",
    kind: "interactive",
    cwd: "/",
    startedAt: 0,
  };

  it("prefers assignedName over everything", () => {
    expect(resolveName({ ...base, assignedName: "given" }, session)).toBe("given");
  });
  it("falls back to the live session name", () => {
    expect(resolveName(base, session)).toBe("live-name");
  });
  it("falls back to host for remotes, then pid", () => {
    expect(resolveName({ ...base, kind: "remote", host: "dev-box" })).toBe("dev-box");
    expect(resolveName(base)).toBe("pid 77");
  });
});
