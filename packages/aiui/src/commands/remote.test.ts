import { describe, expect, it } from "vitest";
import {
  appendConnection,
  ctlArgs,
  DEFAULT_REMOTE_BROWSER_PORT,
  forwardBrowserArgs,
  forwardChannelArgs,
  HISTORY_MAX,
  masterArgs,
  matchRemoteChannel,
  parseRemoteEntries,
  type RemoteConnectionRecord,
  type RemoteHistory,
  remoteExecArgs,
  remoteHostLabel,
  remoteInvocation,
  updateConnection,
} from "./remote";

describe("ssh argv builders", () => {
  it("builds a forward-less keep-alive master (forwards ride -O forward later)", () => {
    const args = masterArgs("/s.sock", "dev-box");
    expect(args).toEqual([
      "-M",
      "-S",
      "/s.sock",
      "-N",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "dev-box",
    ]);
    expect(args).not.toContain("-R");
    expect(args).not.toContain("-L");
  });

  it("adds forwards over the control socket", () => {
    expect(forwardBrowserArgs("/s", "h", 9222, 61234)).toEqual([
      "-S",
      "/s",
      "-O",
      "forward",
      "-R",
      "9222:localhost:61234",
      "h",
    ]);
    expect(forwardChannelArgs("/s", "h", 49300, 51877)).toEqual([
      "-S",
      "/s",
      "-O",
      "forward",
      "-L",
      "49300:localhost:51877",
      "h",
    ]);
    expect(ctlArgs("/s", "h", "check")).toEqual(["-S", "/s", "-O", "check", "h"]);
  });

  it("execs remote commands through the multiplexed connection", () => {
    expect(remoteExecArgs("/s", "h", "echo hi")).toEqual(["-S", "/s", "h", "echo hi"]);
  });
});

describe("remoteInvocation", () => {
  it("carries the browser URL AND the tag the poll will look for", () => {
    expect(remoteInvocation(DEFAULT_REMOTE_BROWSER_PORT, "u-u-i-d")).toBe(
      "aiui claude --aiui-browser-url http://127.0.0.1:9222 --aiui-tag u-u-i-d",
    );
  });
});

describe("parseRemoteEntries", () => {
  const entry = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: 2,
      tag: "t1",
      pid: 1,
      ppid: 2,
      port: 40001,
      cwd: "/remote/app",
      startedAt: "2026-07-20T10:00:00.000Z",
      kind: "channel",
      ...over,
    });

  it("parses one JSON entry per line, skipping junk and non-channels", () => {
    const raw = [
      entry(),
      "garbage {",
      entry({ tag: "dbg", kind: "debug" }),
      "",
      entry({ tag: "t2", browserUrl: "http://127.0.0.1:9222" }),
      JSON.stringify({ tag: "v1-no-schema", port: 1, cwd: "/", startedAt: "x", kind: "channel" }),
    ].join("\n");
    const entries = parseRemoteEntries(raw);
    expect(entries.map((e) => e.tag)).toEqual(["t1", "t2"]);
    expect(entries[1].browserUrl).toBe("http://127.0.0.1:9222");
  });
});

describe("matchRemoteChannel", () => {
  const mk = (tag: string, over: Record<string, unknown> = {}) => ({
    tag,
    port: 40000,
    cwd: "/r",
    startedAt: "2026-07-20T10:00:00.000Z",
    ...over,
  });

  it("prefers the exact tag", () => {
    const match = matchRemoteChannel(
      [mk("other", { browserUrl: "http://127.0.0.1:9222" }), mk("ours")],
      "ours",
      9222,
    );
    expect(match).toMatchObject({ via: "tag", entry: { tag: "ours" } });
  });

  it("falls back to the newest channel attached to OUR browser forward", () => {
    const match = matchRemoteChannel(
      [
        mk("old", { browserUrl: "http://127.0.0.1:9222", startedAt: "2026-07-20T09:00:00.000Z" }),
        mk("new", { browserUrl: "http://127.0.0.1:9222", startedAt: "2026-07-20T10:00:00.000Z" }),
        mk("elsewhere", { browserUrl: "http://127.0.0.1:9333" }),
      ],
      "missing",
      9222,
    );
    expect(match).toMatchObject({ via: "browser-url", entry: { tag: "new" } });
  });

  it("returns undefined when nothing matches", () => {
    expect(matchRemoteChannel([mk("x")], "missing", 9222)).toBeUndefined();
  });
});

describe("connection history (pure core)", () => {
  const record = (
    tag: string,
    over: Partial<RemoteConnectionRecord> = {},
  ): RemoteConnectionRecord => ({
    tag,
    browserPort: 9222,
    channelPort: 49300,
    createdAt: "2026-07-20T10:00:00.000Z",
    state: "pending",
    ...over,
  });
  const empty: RemoteHistory = { schema: 1, connections: [] };

  it("appends newest-first, dedupes by tag, caps at the max", () => {
    let history = empty;
    for (let i = 0; i < HISTORY_MAX + 5; i++) {
      history = appendConnection(history, record(`t${i}`));
    }
    expect(history.connections).toHaveLength(HISTORY_MAX);
    expect(history.connections[0].tag).toBe(`t${HISTORY_MAX + 4}`);

    const moved = appendConnection(history, record(`t${HISTORY_MAX}`, { state: "connected" }));
    expect(moved.connections[0]).toMatchObject({ tag: `t${HISTORY_MAX}`, state: "connected" });
    expect(moved.connections.filter((c) => c.tag === `t${HISTORY_MAX}`)).toHaveLength(1);
  });

  it("updates a record in place by tag (including tag adoption)", () => {
    const history = appendConnection(empty, record("mine"));
    const updated = updateConnection(history, "mine", { tag: "adopted", state: "connected" });
    expect(updated.connections[0]).toMatchObject({ tag: "adopted", state: "connected" });
    // A missing tag is a no-op.
    expect(updateConnection(updated, "nope", { state: "pending" })).toEqual(updated);
  });
});

describe("remoteHostLabel", () => {
  it("drops the user part, keeps the host as display identity", () => {
    expect(remoteHostLabel("nehal@dev.example.com")).toBe("dev.example.com");
    expect(remoteHostLabel("dev-box")).toBe("dev-box");
  });
});
