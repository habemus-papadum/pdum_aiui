// @vitest-environment jsdom
/**
 * linter-pulse.test.ts — the mirrored lint lifecycle, converse-only (overhear
 * retired 2026-07-19): synthetic engine events plus the one client-side input
 * (`pulse.lintNow()`, the button) under fake timers. The accumulate pass
 * (listening across talk-ends), the button → thinking transition, the 4s
 * stale warning (once), the tool overlay, barge-in, and the stay-on settle on
 * `linter-turn-complete`.
 */
import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLinterPulse,
  LINTER_NOTED_FLASH_MS,
  LINTER_STALE_MS,
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
const note = (text: string): IntentEvent => ({ at: at(), type: "linter-note", text });
const turnComplete = (segment?: number): IntentEvent => ({
  at: at(),
  type: "linter-turn-complete",
  ...(segment !== undefined ? { segment } : {}),
});

describe("createLinterPulse (converse-only)", () => {
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

  it("walks the on-demand pass: listening → (lint now) → thinking → noted → idle", () => {
    pulse.feed(talkStart(1));
    expect(pulse.view().phase).toBe("listening");

    // Talk-ends change NOTHING: the linter accumulates across segments.
    pulse.feed(talkEnd(1));
    expect(pulse.view().phase).toBe("listening");
    pulse.feed(talkStart(2));
    pulse.feed(talkEnd(2));
    expect(pulse.view().phase).toBe("listening");

    pulse.lintNow(); // the button
    expect(pulse.view().phase).toBe("thinking");

    pulse.feed(note("prefer a stable key"));
    expect(pulse.view()).toMatchObject({ phase: "noted", detail: "prefer a stable key" });

    vi.advanceTimersByTime(LINTER_NOTED_FLASH_MS + 500); // the flash settles
    expect(pulse.view().phase).toBe("idle");
    expect(stale).toBe(0);
  });

  it("a button press with nothing accumulated is a no-op (mirrors the sidecar's guard)", () => {
    expect(pulse.view().phase).toBe("idle");
    pulse.lintNow();
    expect(pulse.view().phase).toBe("idle"); // no window — nothing to judge
    vi.advanceTimersByTime(LINTER_STALE_MS + 1000);
    expect(stale).toBe(0); // and no deadline was armed
  });

  it("talking over a composing reply (barge-in) returns to listening and disarms the deadline", () => {
    pulse.feed(talkStart(1));
    pulse.lintNow(); // thinking — the 4s deadline is running
    pulse.feed(talkStart(2)); // barge-in: the reply is cancelled server-side
    expect(pulse.view().phase).toBe("listening");
    vi.advanceTimersByTime(LINTER_STALE_MS + 1000);
    expect(stale).toBe(0); // no false warning for a lint the user cancelled
  });

  it("no note within the deadline → stale, warned exactly once", () => {
    pulse.feed(talkStart(1));
    pulse.lintNow();
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
    pulse.lintNow();
    pulse.feed({ at: at(), type: "linter-tool-call", tool: "read_file", args: { path: "a.ts" } });
    expect(pulse.view().phase).toBe("tool");
    pulse.feed({
      at: at(),
      type: "linter-tool-result",
      tool: "read_file",
      ok: true,
      summary: "a.ts — 1.0 KB",
    });
    expect(pulse.view().phase).toBe("thinking");
    // The deadline kept running through the overlay.
    vi.advanceTimersByTime(LINTER_STALE_MS + 100);
    expect(pulse.view().phase).toBe("stale");
    expect(stale).toBe(1);
  });

  it("linter-turn-complete settles to idle with every timer disarmed (STAY-ON — ready for round two)", () => {
    pulse.feed(talkStart(1));
    pulse.lintNow(); // thinking — the 4s stale deadline is running
    pulse.feed(turnComplete(1)); // the lint finished
    expect(pulse.view()).toMatchObject({ phase: "idle", detail: "lint turn complete" });
    vi.advanceTimersByTime(LINTER_STALE_MS + 60000);
    expect(stale).toBe(0); // no deadline outlives the completed exchange

    // Stay-on: the next talk starts accumulating again, the button works again.
    pulse.feed(talkStart(2));
    expect(pulse.view().phase).toBe("listening");
    pulse.lintNow();
    expect(pulse.view().phase).toBe("thinking");
  });

  it("fin resets: nothing can arrive after the session closes", () => {
    pulse.feed(talkStart(1));
    pulse.lintNow();
    pulse.feed({ at: at(), type: "thread-close", reason: "send" });
    expect(pulse.view().phase).toBe("idle");
    vi.advanceTimersByTime(LINTER_STALE_MS + 1000);
    expect(stale).toBe(0);
  });

  it("the select rules the view: off shows off, and events feed nothing while off", () => {
    enabled = false;
    pulse.feed(talkStart(1));
    expect(pulse.view().phase).toBe("off");
    pulse.lintNow();
    expect(pulse.view().phase).toBe("off");
    enabled = true;
    expect(pulse.view().phase).toBe("idle"); // nothing was tracked while off
  });
});
