import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import { describe, expect, it } from "vitest";
import {
  type ChannelFormat,
  type ChannelResponse,
  createChannelConnection,
  type FormatRegistry,
} from "./channel";
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
 * never re-sends, so no patched twin is ever on the wire) and the **bare
 * chunkless fin** terminator — asserting the correction
 * lands exactly once. (Segment-ordinal echo and the mock-transcriber path are
 * covered by the unit tests in intent-v1.test.ts.)
 */

const enc = new TextEncoder();
const TID = "thread-1";

interface Harness {
  hello(intent: unknown): Promise<ChannelResponse>;
  events(batch: IntentEvent[]): Promise<ChannelResponse>;
  bareFin(): Promise<ChannelResponse>;
  /** Drop the transport connection (tears down any thread still mid-turn). */
  close(): Promise<void>;
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
    // The client's terminator: a data frame with fin, an EMPTY payload, and NO
    // chunk descriptor.
    bareFin: () =>
      conn.handleFrame(
        encodeFrame({ v: PROTOCOL_VERSION, kind: "data", threadId: TID, fin: true }),
      ),
    close: () => conn.close(),
    prompts,
    pushed,
  };
}

const traced = (format: ChannelFormat, cache: string): ChannelFormat =>
  withTracing(new Map([["intent-v1", format]]), createTraceStore(cache)).get(
    "intent-v1",
  ) as ChannelFormat;

describe("intent-v1 wire contract", () => {
  it("tears down an abandoned turn: onClose marks the trace abandoned, sends nothing", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-int-"));
    const h = harness(traced(createIntentV1Format({}), cache));
    await h.hello({ transcriber: "openai" });

    // A turn that streams a full dictation but never sends the terminating fin.
    await h.events([
      { at: 1, type: "armed", on: true },
      { at: 2, type: "thread-open", trigger: "talk" },
      { at: 3, type: "talk-start", segment: 1 },
      { at: 4, type: "talk-end", segment: 1, ms: 200 },
      {
        at: 5,
        type: "transcript-final",
        segment: 1,
        text: "make the plot wider",
        latencyMs: 100,
        model: "mock",
      },
    ]);

    // The socket drops — the connection tears the still-open thread down via
    // its processor's onClose (the S2 realtime-session teardown seam).
    await h.close();

    // The invariant: an abandoned turn commits nothing observable.
    expect(h.prompts).toEqual([]);
    // The trace records the run as abandoned rather than leaving it open-ended.
    const [trace] = listTraces(cache);
    expect(trace.status).toBe("abandoned");
    // A second close (e.g. a duplicate socket 'close' event) is a harmless no-op.
    await expect(h.close()).resolves.toBeUndefined();
    expect(trace.status).toBe("abandoned");
  });
});
