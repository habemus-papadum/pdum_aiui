import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeIntent, type IntentEvent } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { describe, expect, it } from "vitest";
import type { ChannelFormat, MessageMeta, StreamProcessor, ThreadContext } from "./channel";
import type { ChunkDescriptor, HelloMeta } from "./frame";
import { createIntentV1Format } from "./intent-v1";
import {
  openRealtimeSession,
  type RealtimeCallbacks,
  type RealtimeSocketFactory,
  type RealtimeSocketHandlers,
} from "./realtime";
import { createTraceStore, listTraces } from "./trace";
import { withTracing } from "./tracing";

/**
 * A scripted fake of the OpenAI realtime upstream: it captures the messages the
 * session sends (parsed) and lets the test drive the server side — `open()` to
 * fire the handshake, `emit()` to deliver a server event. The whole realtime
 * path runs offline and keyless through this seam (the reason the factory is
 * injectable, mirroring `transcribe.ts`'s injected `fetch`).
 */
interface FakeUpstream {
  factory: RealtimeSocketFactory;
  /** Parsed JSON of every message the session sent upstream. */
  sent: Array<Record<string, unknown>>;
  /** True once the session closed the socket. */
  closed: boolean;
  /** Fire the socket's open (the session responds with session.update). */
  open(): void;
  /** Deliver a server event to the session. */
  emit(message: Record<string, unknown>): void;
  /** Deliver a raw (possibly malformed) upstream frame. */
  raw(text: string): void;
  /** Fire an upstream error. */
  error(message: string): void;
}

function fakeUpstream(): FakeUpstream {
  let handlers: RealtimeSocketHandlers | undefined;
  const up: FakeUpstream = {
    sent: [],
    closed: false,
    factory: (_url, _apiKey, h) => {
      handlers = h;
      return {
        send: (text) => up.sent.push(JSON.parse(text)),
        close: () => {
          up.closed = true;
          handlers?.onClose();
        },
      };
    },
    open: () => handlers?.onOpen(),
    emit: (message) => handlers?.onMessage(JSON.stringify(message)),
    raw: (text) => handlers?.onMessage(text),
    error: (message) => handlers?.onError(message),
  };
  return up;
}

const delta = (itemId: string, text: string) => ({
  type: "conversation.item.input_audio_transcription.delta",
  item_id: itemId,
  delta: text,
});
const completed = (itemId: string, transcript: string) => ({
  type: "conversation.item.input_audio_transcription.completed",
  item_id: itemId,
  transcript,
});

// ── the session state machine, in isolation ──────────────────────────────────

describe("openRealtimeSession", () => {
  function collect(up: FakeUpstream, now: () => number = () => 0) {
    const deltas: Array<{ segment: number; text: string }> = [];
    const finals: Array<{ segment: number; text: string; latencyMs: number; model: string }> = [];
    const errors: Array<{ message: string; segment?: number }> = [];
    const cb: RealtimeCallbacks = {
      onDelta: (segment, text) => deltas.push({ segment, text }),
      onFinal: (segment, result) => finals.push({ segment, ...result }),
      onError: (message, segment) =>
        errors.push({ message, ...(segment !== undefined ? { segment } : {}) }),
    };
    const session = openRealtimeSession(
      { apiKey: "k", model: () => "gpt-realtime-whisper", socketFactory: up.factory, now },
      cb,
    );
    return { session, deltas, finals, errors };
  }

  it("configures a GA transcription session on open (pcm/24k, turn_detection null)", () => {
    const up = fakeUpstream();
    collect(up);
    up.open();
    expect(up.sent).toHaveLength(1);
    expect(up.sent[0]).toMatchObject({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: { model: "gpt-realtime-whisper" },
            turn_detection: null,
          },
        },
      },
    });
  });

  it("queues audio until session.updated, then flushes appends in order", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open(); // session.update sent, but not ready yet
    session.appendAudio(1, new Uint8Array([1, 2]));
    session.appendAudio(1, new Uint8Array([3, 4]));
    // Nothing but the session.update has gone out — appends are queued.
    expect(up.sent.filter((m) => m.type === "input_audio_buffer.append")).toHaveLength(0);
    up.emit({ type: "session.updated" });
    const appends = up.sent.filter((m) => m.type === "input_audio_buffer.append");
    expect(appends).toHaveLength(2);
    expect(Buffer.from(appends[0].audio as string, "base64")).toEqual(Buffer.from([1, 2]));
    expect(Buffer.from(appends[1].audio as string, "base64")).toEqual(Buffer.from([3, 4]));
  });

  it("accumulates deltas into cumulative text and times the final from commit", () => {
    let clock = 0;
    const up = fakeUpstream();
    const { session, deltas, finals } = collect(up, () => clock);
    up.open();
    up.emit({ type: "session.updated" });
    clock = 1000;
    session.commit(1); // committed at t=1000
    up.emit(delta("item_a", "Make "));
    up.emit(delta("item_a", "the plot"));
    clock = 1800;
    up.emit(completed("item_a", "Make the plot wider"));

    expect(deltas).toEqual([
      { segment: 1, text: "Make " },
      { segment: 1, text: "Make the plot" }, // cumulative, not the raw delta
    ]);
    expect(finals).toEqual([
      { segment: 1, text: "Make the plot wider", latencyMs: 800, model: "gpt-realtime-whisper" },
    ]);
  });

  it("maps two committed segments to their finals in commit (FIFO) order", () => {
    const up = fakeUpstream();
    const { session, finals } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.commit(1);
    session.commit(2);
    // Items complete in the order they were committed.
    up.emit(completed("item_1", "first segment"));
    up.emit(completed("item_2", "second segment"));
    expect(finals).toEqual([
      { segment: 1, text: "first segment", latencyMs: 0, model: "gpt-realtime-whisper" },
      { segment: 2, text: "second segment", latencyMs: 0, model: "gpt-realtime-whisper" },
    ]);
  });

  it("drain resolves once the committed segment completes", async () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.commit(1);
    const drained = session.drain(1000);
    up.emit(completed("item_1", "done"));
    await expect(drained).resolves.toEqual([]); // nothing outstanding
  });

  it("drain times out with the still-pending segments", async () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.commit(3);
    await expect(session.drain(20)).resolves.toEqual([3]);
  });

  it("an upstream error finalizes every outstanding segment loudly", () => {
    const up = fakeUpstream();
    const { session, errors } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.commit(1);
    session.commit(2);
    up.emit({ type: "error", error: { message: "buffer too small" } });
    expect(errors).toEqual([
      { message: "buffer too small", segment: 1 },
      { message: "buffer too small", segment: 2 },
    ]);
    // Once dead, a later commit fails immediately rather than hanging.
    session.commit(3);
    expect(errors.at(-1)).toEqual({ message: "realtime session unavailable", segment: 3 });
  });

  it("close() closes the upstream socket and releases a pending drain", async () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.commit(1);
    const drained = session.drain(10_000);
    session.close();
    expect(up.closed).toBe(true);
    await expect(drained).resolves.toEqual([1]);
  });

  it("ignores a malformed upstream frame instead of throwing", () => {
    const up = fakeUpstream();
    collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    expect(() => up.raw("not json")).not.toThrow();
  });
});

// ── the intent-v1 processor driving a realtime turn ──────────────────────────

const enc = new TextEncoder();

interface Driver {
  feedEvents(events: IntentEvent[], fin?: boolean): Promise<void>;
  feedAudio(id: string, seq: number, bytes: Uint8Array): Promise<void>;
  fin(): Promise<void>;
  close(): Promise<void> | void;
  sent: Array<{ text: string; meta?: Record<string, string> }>;
  pushed: Array<{ events: IntentEvent[] }>;
  isClosed(): boolean;
}

function driveRealtime(opts: {
  factory?: RealtimeSocketFactory;
  apiKey?: string;
  cache?: string;
  hello?: HelloMeta;
}): Driver {
  const sent: Driver["sent"] = [];
  const pushed: Driver["pushed"] = [];
  let closed = false;
  const ctx: ThreadContext = {
    threadId: "t-rt",
    hello: opts.hello ?? { intent: { transcriber: "openai-realtime" } },
    sendPrompt: (text, meta) => sent.push({ text, ...(meta !== undefined ? { meta } : {}) }),
    push: (message) => pushed.push(message as { events: IntentEvent[] }),
    close: () => {
      closed = true;
    },
  };
  let format: ChannelFormat = createIntentV1Format({
    ...(opts.factory !== undefined ? { realtimeSocketFactory: opts.factory } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  });
  if (opts.cache !== undefined) {
    format = withTracing(new Map([["intent-v1", format]]), createTraceStore(opts.cache)).get(
      "intent-v1",
    ) as ChannelFormat;
  }
  const processor: StreamProcessor = format.createProcessor(ctx);
  const send = (payload: Uint8Array, chunk: ChunkDescriptor | undefined, fin: boolean) =>
    processor.onMessage(payload, { fin, ...(chunk !== undefined ? { chunk } : {}) } as MessageMeta);
  return {
    feedEvents: (events, fin = false) =>
      send(enc.encode(JSON.stringify({ events })), { kind: "events" }, fin),
    feedAudio: (id, seq, bytes) =>
      send(bytes, { kind: "audio", id, seq, mime: "audio/pcm;rate=24000" }, false),
    fin: () => send(new Uint8Array(0), undefined, true),
    close: () => processor.onClose?.(),
    sent,
    pushed,
    isClosed: () => closed,
  };
}

// `?? []` skips non-event pushes (fin's `lowered-prompt` carries no events).
const pushedEvents = (pushed: Array<{ events: IntentEvent[] }>): IntentEvent[] =>
  pushed.flatMap((p) => p.events ?? []);

describe("intent-v1 realtime transcription (streaming)", () => {
  it("streams audio → delta echoes in order → commit at talk-end → final → compose", async () => {
    const up = fakeUpstream();
    const cache = mkdtempSync(join(tmpdir(), "aiui-rt-"));
    const d = driveRealtime({ factory: up.factory, apiKey: "k", cache });
    up.open();
    up.emit({ type: "session.updated" });

    await d.feedEvents([
      { at: 1, type: "armed", on: true },
      { at: 2, type: "thread-open", trigger: "talk" },
      { at: 3, type: "talk-start", segment: 1 },
    ]);
    // Audio streams DURING talk, in seq order.
    await d.feedAudio("seg_1", 0, new Uint8Array([10, 20]));
    await d.feedAudio("seg_1", 1, new Uint8Array([30, 40]));
    expect(up.sent.filter((m) => m.type === "input_audio_buffer.append")).toHaveLength(2);

    // talk-end is the commit boundary.
    await d.feedEvents([{ at: 4, type: "talk-end", segment: 1, ms: 400 }]);
    expect(up.sent.some((m) => m.type === "input_audio_buffer.commit")).toBe(true);

    // Partial deltas are incremental upstream; the echo is the cumulative text.
    up.emit(delta("item_1", "make "));
    up.emit(delta("item_1", "the plot"));
    const deltas = pushedEvents(d.pushed).filter((e) => e.type === "transcript-delta");
    expect(
      deltas.map((e) => (e as Extract<IntentEvent, { type: "transcript-delta" }>).text),
    ).toEqual(["make ", "make the plot"]);

    // The completed event merges as a transcript-final and lowers into the prompt.
    up.emit(completed("item_1", "make the plot wider"));
    const finals = pushedEvents(d.pushed).filter((e) => e.type === "transcript-final");
    expect(finals).toHaveLength(1);
    expect((finals[0] as Extract<IntentEvent, { type: "transcript-final" }>).text).toBe(
      "make the plot wider",
    );

    await d.fin();
    expect(d.isClosed()).toBe(true);
    expect(up.closed).toBe(true); // the session was closed at fin
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].text).toBe("make the plot wider");

    // The trace saved the streamed PCM as one blob at commit.
    const [trace] = listTraces(cache);
    expect(trace.stages.map((s) => s.label)).toContain("realtime commit seg_1");
  });

  it("drains an in-flight final at fin (a fast Enter still gets the transcript)", async () => {
    const up = fakeUpstream();
    const d = driveRealtime({ factory: up.factory, apiKey: "k" });
    up.open();
    up.emit({ type: "session.updated" });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
    ]);
    await d.feedAudio("seg_1", 0, new Uint8Array([1, 2, 3]));
    await d.feedEvents([{ at: 3, type: "talk-end", segment: 1, ms: 200 }]);

    // fin arrives BEFORE the upstream completed — lower() awaits the drain.
    const finished = d.fin();
    // The completed lands while lower() is draining.
    up.emit(completed("item_1", "reaction diffusion on the gpu"));
    await finished;

    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].text).toBe("reaction diffusion on the gpu");
  });

  it("tolerates out-of-order / gapped seq (forwards in arrival order, notes it)", async () => {
    const up = fakeUpstream();
    const cache = mkdtempSync(join(tmpdir(), "aiui-rt-"));
    const d = driveRealtime({ factory: up.factory, apiKey: "k", cache });
    up.open();
    up.emit({ type: "session.updated" });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
    ]);
    // seq 0, then 2 (gap), then 1 (reorder) — all forwarded, none rejected.
    await d.feedAudio("seg_1", 0, new Uint8Array([1]));
    await d.feedAudio("seg_1", 2, new Uint8Array([2]));
    await d.feedAudio("seg_1", 1, new Uint8Array([3]));
    expect(up.sent.filter((m) => m.type === "input_audio_buffer.append")).toHaveLength(3);
    const [trace] = listTraces(cache);
    // The reorder (seq 1 after 2) was recorded, not thrown.
    expect(trace.stages.some((s) => s.label === "audio seg_1 out-of-order")).toBe(true);
  });

  it("keyless realtime finalizes the segment loudly (no silent switch to mock)", async () => {
    // openai-realtime requested, forced-empty key, no test factory → no session.
    const d = driveRealtime({ apiKey: "", hello: { intent: { transcriber: "openai-realtime" } } });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
      { at: 3, type: "talk-end", segment: 1, ms: 200 },
    ]);
    const events = pushedEvents(d.pushed);
    expect(events.map((e) => e.type)).toEqual(["transcript-final", "note"]);
    expect((events[0] as Extract<IntentEvent, { type: "transcript-final" }>).text).toBe("");
    expect((events[1] as Extract<IntentEvent, { type: "note" }>).text).toMatch(/OPENAI_API_KEY/);
  });

  it("an upstream error after commit echoes an empty final + a loud note", async () => {
    const up = fakeUpstream();
    const d = driveRealtime({ factory: up.factory, apiKey: "k" });
    up.open();
    up.emit({ type: "session.updated" });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
      { at: 3, type: "talk-end", segment: 1, ms: 200 },
    ]);
    up.error("connection reset");
    const events = pushedEvents(d.pushed);
    expect(events.map((e) => e.type)).toEqual(["transcript-final", "note"]);
    expect((events[1] as Extract<IntentEvent, { type: "note" }>).text).toMatch(/connection reset/);
  });

  it("onClose (abandoned turn) closes the upstream socket and sends nothing", async () => {
    const up = fakeUpstream();
    const d = driveRealtime({ factory: up.factory, apiKey: "k" });
    up.open();
    up.emit({ type: "session.updated" });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
    ]);
    await d.feedAudio("seg_1", 0, new Uint8Array([1, 2, 3]));

    // The socket drops mid-turn — the processor's onClose tears the session down.
    await d.close();
    expect(up.closed).toBe(true);
    expect(d.sent).toEqual([]);
  });
});

// ── the captured streaming-wire fixture ──────────────────────────────────────

interface StreamStep {
  dir: "c2s" | "s2c";
  chunk?: ChunkDescriptor;
  events?: IntentEvent[];
  bytes?: number[];
  server?: Record<string, unknown>;
  fin?: boolean;
}
interface StreamFixture {
  config: { transcriber: string };
  steps: StreamStep[];
}

const fixturePath = fileURLToPath(
  new URL(
    "../../aiui-dev-overlay/workbench/fixtures/streaming/realtime-turn.json",
    import.meta.url,
  ),
);

describe("intent-v1 realtime streaming fixture", () => {
  it("replays the captured wire sequence: deltas echo, only the final composes", async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as StreamFixture;
    const up = fakeUpstream();
    const d = driveRealtime({
      factory: up.factory,
      apiKey: "k",
      hello: { intent: fixture.config },
    });
    up.open();
    up.emit({ type: "session.updated" });

    const clientEvents: IntentEvent[] = [];
    for (const step of fixture.steps) {
      if (step.dir === "s2c" && step.server) {
        up.emit(step.server);
      } else if (step.fin) {
        await d.fin();
      } else if (step.chunk?.kind === "events" && step.events) {
        clientEvents.push(...step.events);
        await d.feedEvents(step.events);
      } else if (step.chunk?.kind === "audio" && step.bytes) {
        await d.feedAudio(step.chunk.id, step.chunk.seq, new Uint8Array(step.bytes));
      }
    }

    // The echoes are the delta→delta→final progression, deltas cumulative.
    const echoes = pushedEvents(d.pushed);
    expect(echoes.map((e) => e.type)).toEqual([
      "transcript-delta",
      "transcript-delta",
      "transcript-final",
    ]);
    expect((echoes[1] as Extract<IntentEvent, { type: "transcript-delta" }>).text).toBe(
      "reaction diffusion on the gpu",
    );

    // The committed prompt is exactly what the client events + the server's FINAL
    // compose to — the partial deltas are noise that must not leak into the send.
    const final = echoes.find((e) => e.type === "transcript-final") as Extract<
      IntentEvent,
      { type: "transcript-final" }
    >;
    const expected = composeIntent([...clientEvents, final], "replace").prompt;
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].text).toBe(expected);
    expect(d.sent[0].text).toBe("reaction diffusion on the GPU");
  });
});
