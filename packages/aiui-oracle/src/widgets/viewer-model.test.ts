/** The viewer's pure model: turn grouping, summaries, the activity line. */
import { describe, expect, it } from "vitest";
import type { OracleState } from "../session";
import type { LedgerEntry } from "../types";
import { activityLine, categoryOf, groupTurns, summarizeTurn } from "./viewer-model";

let seq = 0;
const entry = (body: Omit<LedgerEntry, "at" | "seq">): LedgerEntry =>
  ({ at: 0, seq: ++seq, ...body }) as LedgerEntry;

describe("groupTurns", () => {
  it("heard and user-injected utterances open turns; system injections ride along", () => {
    const led = [
      entry({ kind: "session", phase: "live" }),
      entry({ kind: "config", effective: {} }),
      entry({ kind: "heard", text: "make it square" }),
      entry({ kind: "tool-call", callId: "c1", name: "set_wave", args: "{}", status: "completed" }),
      entry({ kind: "said", responseId: "r1", text: "done" }),
      entry({ kind: "injected", role: "system", text: "context note" }),
      entry({ kind: "injected", role: "user", text: "and faster" }),
      entry({ kind: "said", responseId: "r2", text: "sure" }),
    ];
    const groups = groupTurns(led);
    expect(groups.map((g) => g.entries.length)).toEqual([2, 4, 2]);
    expect(groups[0]?.id).toBe(0); // the leading session group
    expect(groups[1]?.entries[0]?.kind).toBe("heard");
    // the system injection stayed inside the first turn
    expect(groups[1]?.entries.some((e) => e.kind === "injected")).toBe(true);
  });
});

describe("summarizeTurn", () => {
  it("tells the turn's story: ask, tool count, reply, tokens", () => {
    const groups = groupTurns([
      entry({ kind: "heard", text: "make the waveform a square wave please" }),
      entry({ kind: "tool-call", callId: "c1", name: "set_wave", args: "{}", status: "completed" }),
      entry({
        kind: "response",
        responseId: "r1",
        status: "completed",
        usage: { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 200, responses: 1 },
      }),
      entry({ kind: "said", responseId: "r1", text: "done, it is square now" }),
    ]);
    const summary = summarizeTurn(groups[0] as never);
    expect(summary).toContain("🎙 make the waveform");
    expect(summary).toContain("⚙ 1");
    expect(summary).toContain("🔮 done");
    expect(summary).toContain("1200 tok");
  });
});

describe("categoryOf defaults", () => {
  it("keeps conversation/tools/config/errors, drops flow/raw", () => {
    expect(categoryOf(entry({ kind: "heard", text: "x" }))).toBe("turn");
    expect(categoryOf(entry({ kind: "speech", phase: "started" }))).toBe("flow");
    expect(categoryOf(entry({ kind: "raw", type: "t", event: {} }))).toBe("raw");
    expect(categoryOf(entry({ kind: "error", source: "vendor", message: "m" }))).toBe("error");
  });
});

describe("activityLine", () => {
  const base: OracleState = {
    status: "live",
    speaking: false,
    replying: false,
    replyText: "",
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, responses: 0 },
    toolNames: [],
    playbackBlocked: false,
  };
  it("ranks the cues: listening > doing > thinking/reply > ready", () => {
    expect(activityLine({ ...base, speaking: true }).text).toBe("listening…");
    expect(activityLine({ ...base, runningTool: "set_freq" }).text).toBe("doing: set_freq");
    expect(activityLine({ ...base, replying: true }).text).toBe("thinking…");
    expect(activityLine({ ...base, replying: true, replyText: "the wave is" }).text).toContain(
      "the wave is",
    );
    expect(activityLine(base).text).toContain("ready");
    expect(activityLine({ ...base, status: "parked" }).text).toContain("parked");
  });
});
