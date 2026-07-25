import type { ChannelListing, ClaudeAgent, EnrichedChannel } from "@habemus-papadum/aiui-registry";
import { describe, expect, it } from "vitest";
import {
  ago,
  type FormatOptions,
  formatChannel,
  formatListing,
  sessionsWithoutChannel,
} from "./channels";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");

const OPTS: FormatOptions = {
  baseDir: "/Users/nehal/src/pdum_aiui",
  nowMs: NOW,
  registryDir: "/Users/nehal/.cache/aiui/mcp",
};

/** A fully-populated local channel with its live session join. */
function channel(overrides: Partial<EnrichedChannel> = {}): EnrichedChannel {
  return {
    schema: 2,
    tag: "aiui-3f2ab1c8",
    pid: 41207,
    ppid: 41190,
    port: 49301,
    cwd: "/Users/nehal/src/pdum_aiui",
    startedAt: "2026-07-25T08:48:00.000Z",
    kind: "channel",
    browserUrl: "http://127.0.0.1:9222",
    file: "/Users/nehal/.cache/aiui/mcp/41207.json",
    resolvedName: "pdum-aiui-97",
    session: {
      sessionId: "0f1e2d3c-aaaa-bbbb-cccc-ddddeeeeffff",
      name: "pdum-aiui-97",
      status: "idle",
      kind: "interactive",
      cwd: "/Users/nehal/src/pdum_aiui",
      startedAt: Date.parse("2026-07-25T08:00:00.000Z"),
    },
    ...overrides,
  };
}

/** One `claude agents --json --all` record. */
function agent(overrides: Partial<ClaudeAgent> = {}): ClaudeAgent {
  return {
    pid: 41190,
    cwd: "/Users/nehal/src/pdum_aiui",
    kind: "interactive",
    startedAt: Date.parse("2026-07-25T08:00:00.000Z"),
    sessionId: "0f1e2d3c-aaaa-bbbb-cccc-ddddeeeeffff",
    name: "pdum-aiui-97",
    status: "idle",
    ...overrides,
  };
}

function listing(overrides: Partial<ChannelListing> = {}): ChannelListing {
  return {
    protocol: 2,
    channels: [channel()],
    agents: { status: "ok", claudePath: "/opt/claude/bin/claude" },
    ...overrides,
  };
}

/** The block as one searchable string — the formatter returns lines. */
function text(lines: string[]): string {
  return lines.join("\n");
}

describe("formatChannel", () => {
  it("prints every value the entry carries", () => {
    const out = text(formatChannel(channel(), OPTS));
    for (const value of [
      "pdum-aiui-97",
      "aiui-3f2ab1c8",
      "41207",
      "parent 41190",
      "49301",
      "http://127.0.0.1:49301/",
      "/Users/nehal/src/pdum_aiui",
      "2026-07-25T08:48:00.000Z",
      "http://127.0.0.1:9222",
      "/Users/nehal/.cache/aiui/mcp/41207.json",
      "schema 2",
      "0f1e2d3c-aaaa-bbbb-cccc-ddddeeeeffff",
      "interactive",
    ]) {
      expect(out).toContain(value);
    }
  });

  it("dates both timestamp shapes — ISO on the entry, epoch ms on the session", () => {
    const out = text(formatChannel(channel(), OPTS));
    expect(out).toContain("3h 12m ago"); // the entry's ISO startedAt
    expect(out).toContain("2026-07-25T08:00:00.000Z"); // the session's epoch ms, rendered
    expect(out).toContain("4h 0m ago");
  });

  it("marks the channel launched in the current directory", () => {
    expect(text(formatChannel(channel(), OPTS))).toContain("this directory");
    const elsewhere = channel({ cwd: "/Users/nehal/src/other" });
    expect(text(formatChannel(elsewhere, OPTS))).not.toContain("this directory");
  });

  it("omits the optional fields an entry doesn't have", () => {
    const bare = channel({ browserUrl: undefined, session: undefined });
    const out = text(formatChannel(bare, OPTS));
    expect(out).not.toContain("browser");
    expect(out).not.toContain("undefined");
  });

  it("shows a remote entry's host and assigned name", () => {
    const remote = channel({
      kind: "remote",
      host: "gpubox",
      assignedName: "gpubox",
      resolvedName: "gpubox",
      session: undefined,
    });
    const out = text(formatChannel(remote, OPTS));
    expect(out).toContain("gpubox");
    expect(out).toContain("remote");
    // A remote/debug entry structurally has no session join — not a symptom.
    expect(out).not.toContain("no live session");
  });

  it("calls out a real channel whose session join is missing", () => {
    const orphan = channel({ session: undefined, resolvedName: "pid 41190" });
    expect(text(formatChannel(orphan, OPTS))).toContain("no live session for pid 41190");
  });
});

describe("formatListing", () => {
  it("heads the listing with the count, protocol, and registry directory", () => {
    const out = text(formatListing(listing(), OPTS));
    expect(out).toContain("1 channel ");
    expect(out).toContain("protocol 2");
    expect(out).toContain("/Users/nehal/.cache/aiui/mcp");
  });

  it("pluralises and prints a block per channel", () => {
    const two = listing({ channels: [channel(), channel({ pid: 41208, tag: "aiui-second" })] });
    const out = text(formatListing(two, OPTS));
    expect(out).toContain("2 channels");
    expect(out).toContain("aiui-3f2ab1c8");
    expect(out).toContain("aiui-second");
  });

  it("says so, with the fix, when nothing is registered", () => {
    const out = text(formatListing(listing({ channels: [] }), OPTS));
    expect(out).toContain("no channels");
    expect(out).toContain("aiui claude");
  });

  // Discovery does not fail because naming did — but it must never look fine.
  it("warns loudly when the claude binary is missing", () => {
    const degraded = listing({
      agents: { status: "claude-missing", claudePath: "/nope/claude" },
    });
    const out = text(formatListing(degraded, OPTS));
    expect(out).toContain("session names unavailable");
    expect(out).toContain("/nope/claude");
  });

  it("surfaces an agents-fetch error", () => {
    const failed = listing({ agents: { status: "error", error: "spawn EACCES" } });
    expect(text(formatListing(failed, OPTS))).toContain("spawn EACCES");
  });
});

describe("sessionsWithoutChannel", () => {
  const other = agent({ pid: 55555, name: "nanochat-cf", cwd: "/Users/nehal/src/nanochat" });

  it("drops the sessions a channel already joined", () => {
    const out = sessionsWithoutChannel(listing(), [agent(), other], OPTS.baseDir);
    expect(out.map((s) => s.name)).toEqual(["nanochat-cf"]);
  });

  // A debug/remote entry's ppid is whatever shell launched it — it joins no
  // session, so it must not hide one that happens to share that pid.
  it("does not let an unjoined entry claim a session by ppid", () => {
    const debug = listing({
      channels: [channel({ kind: "debug", ppid: 41190, session: undefined })],
    });
    const out = sessionsWithoutChannel(debug, [agent()], OPTS.baseDir);
    expect(out.map((s) => s.name)).toEqual(["pdum-aiui-97"]);
  });

  it("ranks by the same directory affinity as the channels", () => {
    const here = agent({ pid: 60001, name: "here" });
    const out = sessionsWithoutChannel(listing({ channels: [] }), [other, here], OPTS.baseDir);
    expect(out.map((s) => s.name)).toEqual(["here", "nanochat-cf"]);
  });
});

describe("formatListing with unclaimed sessions", () => {
  const sessions = [agent({ pid: 55555, name: "nanochat-cf", cwd: "/Users/nehal/src/nanochat" })];

  it("prints them with their status, pid, age, and cwd", () => {
    const out = text(formatListing(listing(), { ...OPTS, sessions }));
    expect(out).toContain("1 Claude Code session with no channel");
    expect(out).toContain("nanochat-cf");
    expect(out).toContain("pid 55555");
    expect(out).toContain("/Users/nehal/src/nanochat");
  });

  it("says nothing at all when every session has a channel", () => {
    const out = text(formatListing(listing(), { ...OPTS, sessions: [] }));
    expect(out).not.toContain("no channel");
  });

  // An empty registry with sessions running is the interesting case: the fix
  // is "relaunch with `aiui claude`", and you can only see that from both.
  it("shows them even when no channel is registered", () => {
    const out = text(formatListing(listing({ channels: [] }), { ...OPTS, sessions }));
    expect(out).toContain("no channels");
    expect(out).toContain("nanochat-cf");
  });
});

describe("ago", () => {
  it("scales the unit with the age", () => {
    expect(ago(NOW - 30_000, NOW)).toBe("30s ago");
    expect(ago(NOW - 90_000, NOW)).toBe("1m ago");
    expect(ago(NOW - 3 * 3_600_000 - 720_000, NOW)).toBe("3h 12m ago");
    expect(ago(NOW - 50 * 3_600_000, NOW)).toBe("2d 2h ago");
  });

  it("never prints NaN for an unparseable timestamp", () => {
    expect(ago("not a date", NOW)).toBe("unknown age");
  });
});
