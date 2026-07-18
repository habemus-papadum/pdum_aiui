import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import { describe, expect, it, vi } from "vitest";
import { createTracePoll } from "./sources";

const twoEvents: IntentEvent[] = [
  { at: 1, type: "thread-open", trigger: "talk" },
  { at: 2, type: "talk-start", segment: 1 },
];
const threeEvents: IntentEvent[] = [...twoEvents, { at: 3, type: "talk-end", segment: 1, ms: 300 }];

/** A minimal fetch double standing in for the channel's /live route. */
function fakeRes(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

describe("createTracePoll", () => {
  it("reports change → unchanged → change and echoes ?since after the first hit", async () => {
    const urls: string[] = [];
    let body: unknown = { rev: 100, stages: [{ kind: "input", data: twoEvents }] };
    const fetchStub = vi.fn(async (url: string) => {
      urls.push(url);
      return fakeRes(body);
    });
    const poll = createTracePoll({
      baseUrl: "http://127.0.0.1:9",
      traceId: "t-1",
      fetch: fetchStub as unknown as typeof fetch,
    });

    const first = await poll.poll();
    expect(first.changed).toBe(true);
    expect(first.rev).toBe(100);
    expect(first.trace?.stages).toEqual([{ kind: "input", data: twoEvents }]);
    expect(urls[0]).not.toContain("since="); // no since on the first ask

    body = { unchanged: true, rev: 100 };
    const second = await poll.poll();
    expect(second.changed).toBe(false);
    expect(second.trace).toBeUndefined();
    expect(urls[1]).toContain("since=100"); // echoes the revision it holds

    body = { rev: 200, stages: [{ kind: "input", data: threeEvents }] };
    const third = await poll.poll();
    expect(third.changed).toBe(true);
    expect(third.rev).toBe(200);
    expect(third.trace?.stages).toEqual([{ kind: "input", data: threeEvents }]);
  });

  it("stays quiet (no change) when a poll fails", async () => {
    const poll = createTracePoll({
      baseUrl: "http://127.0.0.1:9",
      traceId: "t-1",
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect((await poll.poll()).changed).toBe(false);
  });
});
