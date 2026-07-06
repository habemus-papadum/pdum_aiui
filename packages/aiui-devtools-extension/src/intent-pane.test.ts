import { describe, expect, it } from "vitest";
import {
  addRecentPort,
  channelBaseUrl,
  degradedKeyLine,
  filterTracesBySession,
  loadRecentPorts,
  saveRecentPorts,
  traceActorBadge,
  traceSessionLabel,
  traceSummaryLine,
} from "./intent-pane.js";

describe("port memory", () => {
  it("puts the newest port first, de-dupes, and caps", () => {
    let recents: number[] = [];
    recents = addRecentPort(recents, 8123);
    recents = addRecentPort(recents, 8124);
    recents = addRecentPort(recents, 8123); // already present → moves to front
    expect(recents).toEqual([8123, 8124]);

    for (const p of [1, 2, 3, 4, 5, 6, 7]) {
      recents = addRecentPort(recents, p);
    }
    expect(recents.length).toBe(6);
    expect(recents[0]).toBe(7);
  });

  it("ignores non-ports", () => {
    expect(addRecentPort([8123], 0)).toEqual([8123]);
    expect(addRecentPort([8123], -1)).toEqual([8123]);
    expect(addRecentPort([8123], 1.5)).toEqual([8123]);
  });

  it("round-trips through a storage double and tolerates garbage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    saveRecentPorts(storage, [8123, 8124]);
    expect(loadRecentPorts(storage)).toEqual([8123, 8124]);

    store.set("aiui.recentPorts", "not json");
    expect(loadRecentPorts(storage)).toEqual([]);

    store.set("aiui.recentPorts", JSON.stringify([8123, "x", -2, 8125]));
    expect(loadRecentPorts(storage)).toEqual([8123, 8125]);

    expect(loadRecentPorts(undefined)).toEqual([]);
  });
});

describe("channelBaseUrl", () => {
  it("is a loopback origin", () => {
    expect(channelBaseUrl(8123)).toBe("http://127.0.0.1:8123");
  });
});

describe("degradedKeyLine", () => {
  it("is silent for a good or unknown-and-fine key", () => {
    expect(degradedKeyLine("valid")).toBeNull();
    expect(degradedKeyLine(undefined)).toBeNull();
  });

  it("explains each degraded status", () => {
    expect(degradedKeyLine("missing")).toContain("isn't set");
    expect(degradedKeyLine("invalid")).toContain("rejected");
    expect(degradedKeyLine("unverified")).toContain("wasn't verified");
    expect(degradedKeyLine("weird")).toContain("degraded");
  });
});

describe("traceSummaryLine", () => {
  it("summarizes stage count and status (older servers' full stages)", () => {
    expect(
      traceSummaryLine({ id: "a", format: "intent-v1", stages: [1], status: "completed" }),
    ).toContain("1 stage · completed");
    expect(traceSummaryLine({ id: "b", format: "intent-v1", stages: [1, 2] })).toContain(
      "2 stages · live",
    );
  });

  it("reads the slimmed route's stageCount", () => {
    expect(
      traceSummaryLine({ id: "c", format: "intent-v1", stageCount: 47, status: "completed" }),
    ).toContain("47 stages · completed");
  });

  it("prefers the turn gloss over the stage count when it has landed", () => {
    const line = traceSummaryLine({
      id: "d",
      format: "intent-v1",
      stageCount: 47,
      status: "completed",
      summary: "rewrite the beet essay to say vite",
    });
    expect(line).toContain("rewrite the beet essay to say vite · completed");
    expect(line).not.toContain("47 stages");
  });
});

describe("traceActorBadge", () => {
  it("badges a non-human actor with its self-reported label", () => {
    expect(traceActorBadge({ actor: "agent" })).toBe("[agent]");
    expect(traceActorBadge({ actor: "bot-7" })).toBe("[bot-7]");
  });

  it("stays silent for a human or unlabeled trace (the unmarked default)", () => {
    expect(traceActorBadge({ actor: "human" })).toBe("");
    expect(traceActorBadge({})).toBe("");
  });
});

describe("filterTracesBySession", () => {
  const mine = { id: "a", format: "intent-v1", session: "wb·1·090507" };
  const other = { id: "b", format: "intent-v1", session: "channel·2·101010" };
  const legacy = { id: "c", format: "intent-v1" }; // pre-upgrade: no session
  const all = [mine, other, legacy];

  it("defaults to only the current server's traces", () => {
    expect(filterTracesBySession(all, "wb·1·090507", false)).toEqual([mine]);
  });

  it("shows everything — other sessions and pre-upgrade traces — under all", () => {
    expect(filterTracesBySession(all, "wb·1·090507", true)).toEqual(all);
  });

  it("cannot filter against a server that reports no session, so shows all", () => {
    expect(filterTracesBySession(all, undefined, false)).toEqual(all);
  });
});

describe("traceSessionLabel", () => {
  it("is the trace's recording session's label", () => {
    expect(traceSessionLabel({ session: "wb·1·090507" })).toBe("wb·1·090507");
  });

  it("reads unknown for a pre-upgrade trace", () => {
    expect(traceSessionLabel({})).toBe("unknown");
  });
});
