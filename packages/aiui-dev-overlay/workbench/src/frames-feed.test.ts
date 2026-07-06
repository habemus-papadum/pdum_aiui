import { describe, expect, it, vi } from "vitest";
import { type FrameEntry, FramesFeed, loweredPromptOf } from "./frames-feed";
import { parseServeReadyLine } from "./serve-ready";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

describe("FramesFeed", () => {
  it("advances its since-cursor and fans entries out to subscribers", async () => {
    const calls: string[] = [];
    const pages: Record<string, unknown> = {
      "0": { seq: 2, entries: [{ seq: 1 }, { seq: 2 }] },
      "2": { seq: 3, entries: [{ seq: 3 }] },
      "3": { seq: 3, entries: [] },
    };
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const since = new URL(String(url)).searchParams.get("since") ?? "0";
      calls.push(since);
      return jsonResponse(pages[since] ?? { seq: Number(since), entries: [] });
    });
    const feed = new FramesFeed({
      baseUrl: "http://127.0.0.1:9",
      intervalMs: 2 ** 30, // the timer must never fire during the test
      fetch: fetchFn as typeof fetch,
    });
    const seen: number[] = [];
    const unsubscribe = feed.subscribe((entries) => {
      seen.push(...entries.map((e) => e.seq));
    });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let subscribe's initial poll land
    await feed.poll();
    await feed.poll();
    unsubscribe();
    // First poll from 0, then from the returned cursor; empty pages fan out nothing.
    expect(calls).toEqual(["0", "2", "3"]);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("treats fetch failures as no-change", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const feed = new FramesFeed({ baseUrl: "http://127.0.0.1:9", fetch: fetchFn as typeof fetch });
    await expect(feed.poll()).resolves.toBeUndefined();
  });
});

describe("loweredPromptOf", () => {
  const push: FrameEntry = {
    seq: 7,
    at: "2026-07-06T00:00:00.000Z",
    dir: "out",
    label: "push lowered-prompt",
    data: { kind: "lowered-prompt", threadId: "t1", prompt: "make it wider", meta: { a: "b" } },
  };

  it("extracts the prompt from a lowered-prompt push", () => {
    expect(loweredPromptOf(push)).toEqual({
      threadId: "t1",
      prompt: "make it wider",
      meta: { a: "b" },
    });
  });

  it("ignores inbound frames and other pushes", () => {
    expect(loweredPromptOf({ ...push, dir: "in" })).toBeUndefined();
    expect(
      loweredPromptOf({
        seq: 1,
        at: "2026-07-06T00:00:00.000Z",
        dir: "out",
        label: "push speech",
        data: { kind: "speech" },
      }),
    ).toBeUndefined();
  });
});

describe("parseServeReadyLine", () => {
  it("parses the machine-readable ready line", () => {
    expect(parseServeReadyLine('AIUI_CHANNEL_SERVE {"port":5123,"pid":42,"debug":true}')).toEqual({
      port: 5123,
      pid: 42,
      debug: true,
    });
  });

  it("rejects chatter, malformed JSON, and missing ports", () => {
    expect(parseServeReadyLine("--- lowered prompt (intent-v1) ---")).toBeUndefined();
    expect(parseServeReadyLine("AIUI_CHANNEL_SERVE {oops")).toBeUndefined();
    expect(parseServeReadyLine('AIUI_CHANNEL_SERVE {"debug":true}')).toBeUndefined();
  });
});
