// @vitest-environment jsdom
/**
 * linter-pulse.test.ts — the mirrored lint lifecycle, driven by synthetic
 * engine events under fake timers: the normal pass (listening →
 * transcript-wait → thinking → noted), the sidecar's merge and barge-in
 * rules, the transcript timeout, the 4s stale warning (once), and the tool
 * overlay. The mirrored constants must match linter-sidecar.ts.
 */
import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLinterPulse,
  LINTER_STALE_MS,
  LINTER_TRANSCRIPT_WAIT_MS,
  type LinterPulse,
} from "./linter-pulse";

const at = () => Date.now();
const talkStart = (segment: number): IntentEvent => ({ at: at(), type: "talk-start", segment });
const talkEnd = (segment: number): IntentEvent => ({
  at: at(),
  type: "talk-end",
  segment,
  ms: 900,
});
const final = (segment: number): IntentEvent =>
  ({
    at: at(),
    type: "transcript-final",
    segment,
    text: "words",
    latencyMs: 80,
    model: "m",
  }) as IntentEvent;
const note = (text: string): IntentEvent => ({ at: at(), type: "linter-note", text });

describe("createLinterPulse", () => {
  let enabled = true;
  let stale = 0;
  let pulse: LinterPulse;

  beforeEach(() => {
    vi.useFakeTimers();
    enabled = true;
    stale = 0;
    pulse = createLinterPulse({ enabled: () => enabled, onStale: () => stale++ });
  });
  afterEach(() => {
    pulse.dispose();
    vi.useRealTimers();
  });

  it("walks the normal pass: listening → transcript-wait → thinking → noted → idle", () => {
    pulse.feed(talkStart(1));
    expect(pulse.view().phase).toBe("listening");

    pulse.feed(talkEnd(1));
    expect(pulse.view().phase).toBe("transcript-wait");

    pulse.feed(final(1));
    expect(pulse.view().phase).toBe("thinking");

    pulse.feed(note("prefer a stable key"));
    expect(pulse.view()).toMatchObject({ phase: "noted", detail: "prefer a stable key" });

    vi.advanceTimersByTime(3000); // the flash settles
    expect(pulse.view().phase).toBe("idle");
    expect(stale).toBe(0);
  });

  it("the transcript timeout still reaches thinking (the sidecar's rule 3)", () => {
    pulse.feed(talkStart(1));
    pulse.feed(talkEnd(1));
    vi.advanceTimersByTime(LINTER_TRANSCRIPT_WAIT_MS + 100);
    expect(pulse.view().phase).toBe("thinking");
  });

  it("a resume during the wait MERGES back to listening (rule 4), no stale later", () => {
    pulse.feed(talkStart(1));
    pulse.feed(talkEnd(1));
    pulse.feed(talkStart(2)); // the human resumed — one longer window
    expect(pulse.view().phase).toBe("listening");
    vi.advanceTimersByTime(20000);
    expect(pulse.view().phase).toBe("listening"); // no timers left ticking
    expect(stale).toBe(0);
  });

  it("talking over a composing reply (barge-in) returns to listening and disarms the deadline", () => {
    pulse.feed(talkStart(1));
    pulse.feed(talkEnd(1));
    pulse.feed(final(1)); // thinking — the 4s deadline is running
    pulse.feed(talkStart(2)); // barge-in: the reply is cancelled server-side
    expect(pulse.view().phase).toBe("listening");
    vi.advanceTimersByTime(LINTER_STALE_MS + 1000);
    expect(stale).toBe(0); // no false warning for a lint the user cancelled
  });

  it("no note within the deadline → stale, warned exactly once", () => {
    pulse.feed(talkStart(1));
    pulse.feed(talkEnd(1));
    pulse.feed(final(1));
    vi.advanceTimersByTime(LINTER_STALE_MS + 100);
    expect(pulse.view().phase).toBe("stale");
    expect(stale).toBe(1);
    vi.advanceTimersByTime(60000);
    expect(stale).toBe(1);

    // A LATE note still lands and clears the warning state.
    pulse.feed(note("late but real"));
    expect(pulse.view().phase).toBe("noted");
  });

  it("a tool call overlays thinking; its result returns there with the deadline intact", () => {
    pulse.feed(talkStart(1));
    pulse.feed(talkEnd(1));
    pulse.feed(final(1));
    pulse.feed({ at: at(), type: "linter-tool-call", tool: "read_file", args: { path: "x" } });
    expect(pulse.view()).toMatchObject({ phase: "tool", detail: "linter tool: read_file" });

    pulse.feed({ at: at(), type: "linter-tool-result", tool: "read_file", ok: true, summary: "s" });
    expect(pulse.view().phase).toBe("thinking");

    // The stale clock kept running through the tool call.
    vi.advanceTimersByTime(LINTER_STALE_MS + 100);
    expect(pulse.view().phase).toBe("stale");
    expect(stale).toBe(1);
  });

  it("fin resets: nothing can arrive after the session closes", () => {
    pulse.feed(talkStart(1));
    pulse.feed(talkEnd(1));
    pulse.feed(final(1));
    pulse.feed({ at: at(), type: "thread-close", reason: "send" });
    expect(pulse.view().phase).toBe("idle");
    vi.advanceTimersByTime(20000);
    expect(stale).toBe(0);
  });

  it("the select rules the view: off shows off, and events feed nothing while off", () => {
    enabled = false;
    expect(pulse.view().phase).toBe("off");
    pulse.feed(talkStart(1));
    enabled = true;
    expect(pulse.view().phase).toBe("idle"); // the off-time event was ignored
  });
});
