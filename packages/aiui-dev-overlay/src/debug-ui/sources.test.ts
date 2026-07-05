import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntentEvent } from "../intent-pipeline";
import { Engine } from "../intent-pipeline";
import {
  createTracePoll,
  engineSource,
  extractIntentEvents,
  type LiveTrace,
  traceLiveSource,
} from "./sources";

const twoEvents: IntentEvent[] = [
  { at: 1, type: "thread-open", trigger: "talk" },
  { at: 2, type: "talk-start", segment: 1 },
];
const threeEvents: IntentEvent[] = [...twoEvents, { at: 3, type: "talk-end", segment: 1, ms: 300 }];

/** A minimal fetch double standing in for the channel's /live route. */
function fakeRes(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

describe("extractIntentEvents", () => {
  it("finds the last stage whose payload is an event log", () => {
    const stages = [
      { kind: "input", label: "hello", data: { config: {} } },
      { kind: "input", label: "frame 0", data: twoEvents },
      { kind: "input", label: "frame 1", data: threeEvents },
      { kind: "output", label: "lowered", data: "make it wider" },
    ];
    expect(extractIntentEvents(stages)).toBe(threeEvents);
  });

  it("returns undefined for traces without an event log (e.g. text-concat)", () => {
    const stages = [
      { kind: "input", label: "chunk", data: "hello " },
      { kind: "output", label: "prompt", data: "hello world" },
    ];
    expect(extractIntentEvents(stages)).toBeUndefined();
    expect(extractIntentEvents(undefined)).toBeUndefined();
  });
});

describe("engineSource", () => {
  it("replays on subscribe then forwards each new event", () => {
    const engine = new Engine();
    engine.setArmed(true); // one event before subscribing
    const seen: number[] = [];
    const unsub = engineSource(engine).subscribe((events) => seen.push(events.length));
    expect(seen).toEqual([1]); // immediate replay
    engine.talkStart(); // thread-open + talk-start
    expect(seen).toEqual([1, 2, 3]);
    unsub();
    engine.talkEnd(); // no longer forwarded
    expect(seen).toEqual([1, 2, 3]);
  });
});

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
    expect(first.events).toEqual(twoEvents);
    expect(urls[0]).not.toContain("since="); // no since on the first ask

    body = { unchanged: true, rev: 100 };
    const second = await poll.poll();
    expect(second.changed).toBe(false);
    expect(second.events).toBeUndefined();
    expect(urls[1]).toContain("since=100"); // echoes the revision it holds

    body = { rev: 200, stages: [{ kind: "input", data: threeEvents }] };
    const third = await poll.poll();
    expect(third.changed).toBe(true);
    expect(third.rev).toBe(200);
    expect(third.events).toEqual(threeEvents);
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

describe("traceLiveSource", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls back on each revision, not on unchanged", async () => {
    vi.useFakeTimers();
    let rev = 100;
    let stages: LiveTrace["stages"] = [{ kind: "input", data: twoEvents }];
    const fetchStub = vi.fn(async (url: string) => {
      const since = new URL(url).searchParams.get("since");
      if (since !== null && Number(since) === rev) {
        return fakeRes({ unchanged: true, rev });
      }
      return fakeRes({ rev, stages });
    });

    const source = traceLiveSource({
      baseUrl: "http://127.0.0.1:9",
      traceId: "t-1",
      intervalMs: 1000,
      fetch: fetchStub as unknown as typeof fetch,
    });

    const seen: number[] = [];
    const unsub = source.subscribe((events) => seen.push(events.length));

    await vi.advanceTimersByTimeAsync(0); // the immediate poll
    expect(seen).toEqual([2]);

    await vi.advanceTimersByTimeAsync(1000); // nothing changed → no callback
    expect(seen).toEqual([2]);

    rev = 200;
    stages = [{ kind: "input", data: threeEvents }];
    await vi.advanceTimersByTimeAsync(1000); // advanced → callback
    expect(seen).toEqual([2, 3]);

    unsub();
    await vi.advanceTimersByTimeAsync(3000); // unsubscribed → timer stopped
    expect(seen).toEqual([2, 3]);
    source.dispose();
  });
});
