import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntentEvent } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { describe, expect, it } from "vitest";
import {
  type ChannelFormat,
  type ChannelResponse,
  createChannelConnection,
  type FormatRegistry,
} from "./channel";
import { type Corrector, mockCorrector } from "./correct";
import { type ChunkDescriptor, encodeFrame, PROTOCOL_VERSION } from "./frame";
import { createIntentV1Format } from "./intent-v1";
import { createTraceStore, listTraces } from "./trace";
import { withTracing } from "./tracing";

/**
 * Channel-side contract lock: drive the *real* connection state machine with the
 * exact frame sequence the graduated modality emits, through
 * `encodeFrame`/`decodeFrame` end to end. One test replaying the whole client
 * turn — an `events` batch carrying a **patchless** correction request (the
 * server diffs + echoes it; the reconciled client applies our echo locally and
 * never re-sends, so no patched twin is ever on the wire), a separate `context`
 * frame, and the **bare chunkless fin** terminator — asserting the correction
 * lands exactly once. (Segment-ordinal echo and the mock-transcriber path are
 * covered by the unit tests in intent-v1.test.ts.)
 */

const enc = new TextEncoder();
const TID = "thread-1";
type Correction = Extract<IntentEvent, { type: "correction" }>;

interface Harness {
  hello(intent: unknown): Promise<ChannelResponse>;
  events(batch: IntentEvent[]): Promise<ChannelResponse>;
  context(selection: unknown): Promise<ChannelResponse>;
  bareFin(): Promise<ChannelResponse>;
  prompts: Array<{ text: string; meta?: Record<string, string> }>;
  pushed: unknown[];
}

function harness(format: ChannelFormat): Harness {
  const prompts: Harness["prompts"] = [];
  const pushed: unknown[] = [];
  const formats: FormatRegistry = new Map([["intent-v1", format]]);
  const conn = createChannelConnection({
    formats,
    sendPrompt: (text, meta) => {
      prompts.push({ text, ...(meta !== undefined ? { meta } : {}) });
    },
    push: (message) => {
      pushed.push(message);
    },
  });
  const data = (chunk: ChunkDescriptor, payload: Uint8Array) =>
    conn.handleFrame(
      encodeFrame({ v: PROTOCOL_VERSION, kind: "data", threadId: TID, chunk }, payload),
    );
  return {
    hello: (intent) =>
      conn.handleFrame(
        encodeFrame({ v: PROTOCOL_VERSION, kind: "hello", format: "intent-v1", meta: { intent } }),
      ),
    events: (batch) => data({ kind: "events" }, enc.encode(JSON.stringify({ events: batch }))),
    context: (selection) => data({ kind: "context" }, enc.encode(JSON.stringify({ selection }))),
    // The client's terminator: a data frame with fin, an EMPTY payload, and NO
    // chunk descriptor.
    bareFin: () =>
      conn.handleFrame(encodeFrame({ v: PROTOCOL_VERSION, kind: "data", threadId: TID, fin: true })),
    prompts,
    pushed,
  };
}

const traced = (format: ChannelFormat, cache: string): ChannelFormat =>
  withTracing(new Map([["intent-v1", format]]), createTraceStore(cache)).get(
    "intent-v1",
  ) as ChannelFormat;

describe("intent-v1 wire contract", () => {
  it("replays a patchless-correction turn: request → echo → context → bare fin, applied once", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-int-"));
    const mc = mockCorrector();
    let diffCalls = 0;
    const countingCorrector: Corrector = {
      name: "counting",
      diff(input) {
        diffCalls += 1;
        return mc.diff(input);
      },
    };
    const h = harness(traced(createIntentV1Format({ corrector: countingCorrector }), cache));
    await h.hello({ corrector: "openai", correctionPolicy: "replace" });

    // A dictation turn plus the PATCHLESS correction request — the only
    // correction the reconciled client puts on the wire (it applies our echo
    // locally rather than re-sending the patched twin).
    await h.events([
      { at: 1, type: "armed", on: true },
      { at: 2, type: "thread-open", trigger: "talk" },
      { at: 3, type: "talk-start", segment: 1 },
      { at: 4, type: "talk-end", segment: 1, ms: 200 },
      {
        at: 5,
        type: "transcript-final",
        segment: 1,
        text: "make the base line curve a bit thicker",
        latencyMs: 100,
        model: "mock",
      },
      {
        at: 6,
        type: "correction",
        from: 9,
        to: 18,
        original: "base line",
        instruction: "baseline",
        via: "typed",
      },
    ]);

    // The server diffed once and echoed the completed (patched) correction.
    expect(diffCalls).toBe(1);
    expect(h.pushed).toHaveLength(1);
    const echoed = (h.pushed[0] as { events: IntentEvent[] }).events[0] as Correction;
    expect(echoed.patch).toContain("*** Begin Patch");

    // Context rides its own frame, just before the bare chunkless terminator.
    await h.context({ text: "the plot", sourceLoc: "src/ui/App.tsx:5:1" });
    const ack = await h.bareFin();
    expect(ack).toMatchObject({ ok: true, threadId: TID, closed: true });

    // Exactly one correction in the merged stream, applied exactly once.
    const [trace] = listTraces(cache);
    const merged = trace.stages.find((s) => s.label === "merged events")?.data as IntentEvent[];
    expect(merged.filter((e) => e.type === "correction")).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].text).toContain("baseline");
    expect(h.prompts[0].text).not.toContain("base line");
    expect(h.prompts[0].text.match(/baseline/g)).toHaveLength(1);
    // The context frame folded its selection into the lowered prompt.
    expect(h.prompts[0].text).toContain('on-screen selection: "the plot"');
  });
});
