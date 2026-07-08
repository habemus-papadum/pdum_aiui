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
  captureUnexpectedResponse,
  closeSuffix,
  openRealtimeSession,
  type RealtimeCallbacks,
  type RealtimeSocketFactory,
  type RealtimeSocketHandlers,
  type UnexpectedResponseSource,
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

  it("forwards deltas that arrive while the segment is still streaming (pre-commit)", () => {
    const up = fakeUpstream();
    const { session, deltas, finals } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.appendAudio(1, new Uint8Array([1, 2]));
    // The GA models transcribe as audio appends — deltas land BEFORE the
    // commit. This is the normal streaming case (the preview fills as you
    // talk); dropping these was the bug where the preview stayed empty until
    // release and then diff-flashed the whole utterance.
    up.emit(delta("item_a", "make "));
    up.emit(delta("item_a", "the plot"));
    expect(deltas).toEqual([
      { segment: 1, text: "make " },
      { segment: 1, text: "make the plot" },
    ]);
    session.commit(1);
    up.emit(delta("item_a", " wider"));
    up.emit(completed("item_a", "make the plot wider"));
    expect(deltas.at(-1)).toEqual({ segment: 1, text: "make the plot wider" });
    expect(finals).toEqual([
      { segment: 1, text: "make the plot wider", latencyMs: 0, model: "gpt-realtime-whisper" },
    ]);
  });

  it("keeps a next segment's pre-commit deltas apart from a still-pending first", () => {
    const up = fakeUpstream();
    const { session, deltas, finals } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.appendAudio(1, new Uint8Array([1]));
    up.emit(delta("item_a", "first"));
    session.commit(1); // its final is still in flight…
    session.appendAudio(2, new Uint8Array([2]));
    up.emit(delta("item_b", "second")); // …when the NEXT segment starts streaming
    expect(deltas).toEqual([
      { segment: 1, text: "first" },
      { segment: 2, text: "second" },
    ]);
    up.emit(completed("item_a", "first"));
    session.commit(2);
    up.emit(completed("item_b", "second"));
    expect(finals.map((f) => ({ segment: f.segment, text: f.text }))).toEqual([
      { segment: 1, text: "first" },
      { segment: 2, text: "second" },
    ]);
  });

  it("discard clears the upstream buffer and tombstones a pre-commit item", () => {
    const up = fakeUpstream();
    const { session, deltas, finals } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.appendAudio(1, new Uint8Array([1, 2]));
    up.emit(delta("item_a", "hm"));
    expect(deltas).toEqual([{ segment: 1, text: "hm" }]);
    session.discard(1);
    expect(up.sent.some((m) => m.type === "input_audio_buffer.clear")).toBe(true);
    expect(up.sent.some((m) => m.type === "input_audio_buffer.commit")).toBe(false);
    // The discarded item's late events drop — even after a NEW segment starts
    // streaming, they must not re-bind to it.
    session.appendAudio(2, new Uint8Array([3]));
    up.emit(delta("item_a", "mm"));
    up.emit(completed("item_a", "hmm"));
    expect(deltas).toHaveLength(1);
    expect(finals).toEqual([]);
    // The next segment's own item binds and streams cleanly.
    up.emit(delta("item_b", "real talk"));
    expect(deltas.at(-1)).toEqual({ segment: 2, text: "real talk" });
  });

  it("never truncates: text from an unbindable delta reaches the first bound one", () => {
    const up = fakeUpstream();
    const { session, deltas } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    // Nothing streaming, nothing committed — the delta can't bind (a stray),
    // but its text must still accumulate for when the item does bind.
    up.emit(delta("item_a", "hello "));
    expect(deltas).toEqual([]);
    session.commit(1);
    up.emit(delta("item_a", "world"));
    expect(deltas).toEqual([{ segment: 1, text: "hello world" }]);
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
    // Audio streams DURING talk, in seq order — two frames of 50 ms each (a
    // real utterance; under 100 ms total the tap debounce would discard it).
    await d.feedAudio("seg_1", 0, new Uint8Array(2400).fill(10));
    await d.feedAudio("seg_1", 1, new Uint8Array(2400).fill(30));
    expect(up.sent.filter((m) => m.type === "input_audio_buffer.append")).toHaveLength(2);

    // Partial deltas stream back DURING talk too (before any commit exists) —
    // incremental upstream; the echo is the cumulative text, live in the preview.
    up.emit(delta("item_1", "make "));
    up.emit(delta("item_1", "the plot"));
    const deltas = pushedEvents(d.pushed).filter((e) => e.type === "transcript-delta");
    expect(
      deltas.map((e) => (e as Extract<IntentEvent, { type: "transcript-delta" }>).text),
    ).toEqual(["make ", "make the plot"]);

    // talk-end is the commit boundary.
    await d.feedEvents([{ at: 4, type: "talk-end", segment: 1, ms: 400 }]);
    expect(up.sent.some((m) => m.type === "input_audio_buffer.commit")).toBe(true);

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

  it("discards a sub-100ms segment instead of committing (the Space-tap debounce)", async () => {
    const up = fakeUpstream();
    const d = driveRealtime({ factory: up.factory, apiKey: "k" });
    up.open();
    up.emit({ type: "session.updated" });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
    ]);
    // A tap: talk-end lands with barely any audio streamed (2 bytes ≈ 0 ms —
    // the worklet often delivers nothing before the key is released).
    await d.feedAudio("seg_1", 0, new Uint8Array([1, 2]));
    await d.feedEvents([{ at: 3, type: "talk-end", segment: 1, ms: 40 }]);
    // No commit went upstream (it would 400 "buffer too small"); the partial
    // buffer was cleared so it can't prepend to the next utterance.
    expect(up.sent.some((m) => m.type === "input_audio_buffer.commit")).toBe(false);
    expect(up.sent.some((m) => m.type === "input_audio_buffer.clear")).toBe(true);
    // The segment resolved QUIETLY: an empty final, no note, no error toast.
    const events = pushedEvents(d.pushed);
    expect(events.map((e) => e.type)).toEqual(["transcript-final"]);
    expect((events[0] as Extract<IntentEvent, { type: "transcript-final" }>).text).toBe("");
    expect(d.pushed.some((p) => (p as { kind?: string }).kind === "error")).toBe(false);

    // A real utterance afterwards commits and transcribes normally.
    await d.feedEvents([{ at: 4, type: "talk-start", segment: 2 }]);
    await d.feedAudio("seg_2", 0, new Uint8Array(4800)); // exactly 100 ms of PCM16@24k
    await d.feedEvents([{ at: 5, type: "talk-end", segment: 2, ms: 500 }]);
    expect(up.sent.some((m) => m.type === "input_audio_buffer.commit")).toBe(true);
    up.emit(completed("item_1", "the real utterance"));
    const finals = pushedEvents(d.pushed).filter((e) => e.type === "transcript-final");
    expect((finals.at(-1) as Extract<IntentEvent, { type: "transcript-final" }>).text).toBe(
      "the real utterance",
    );
    expect((finals.at(-1) as Extract<IntentEvent, { type: "transcript-final" }>).segment).toBe(2);
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
    await d.feedAudio("seg_1", 0, new Uint8Array(4800).fill(1)); // 100 ms — commits
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
    ]);
    await d.feedAudio("seg_1", 0, new Uint8Array(4800).fill(1)); // 100 ms — commits
    await d.feedEvents([{ at: 3, type: "talk-end", segment: 1, ms: 200 }]);
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
  /** Expand `bytes` this many times (PCM is repetitive; keeps the JSON small). */
  repeat?: number;
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
        const repeat = step.repeat ?? 1;
        const frame = new Uint8Array(step.bytes.length * repeat);
        for (let i = 0; i < repeat; i++) {
          frame.set(step.bytes, i * step.bytes.length);
        }
        await d.feedAudio(step.chunk.id, step.chunk.seq, frame);
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

// ── the upstream-fault surfaces (close frames, rejected handshakes) ──────────

describe("closeSuffix", () => {
  it("renders code + reason, code alone, reason alone, and nothing", () => {
    expect(closeSuffix(1008, "API key not valid.")).toBe(" (1008: API key not valid.)");
    expect(closeSuffix(1006, "")).toBe(" (1006)");
    expect(closeSuffix(1006)).toBe(" (1006)");
    expect(closeSuffix(undefined, "going away")).toBe(" (going away)");
    expect(closeSuffix()).toBe("");
    expect(closeSuffix(undefined, "  ")).toBe("");
  });
});

describe("captureUnexpectedResponse", () => {
  /** Drive the listener with a scripted rejected handshake. */
  function reject(statusCode: number, body: string) {
    const errors: Array<{ message: string; data?: unknown }> = [];
    let destroyed = false;
    const handlers: RealtimeSocketHandlers = {
      onOpen: () => {},
      onMessage: () => {},
      onError: (message, data) => errors.push({ message, ...(data !== undefined ? { data } : {}) }),
      onClose: () => {},
    };
    let fire:
      | ((
          request: { destroy(): void },
          response: Parameters<Parameters<UnexpectedResponseSource["on"]>[1]>[1],
        ) => void)
      | undefined;
    const source: UnexpectedResponseSource = {
      on: (_event, listener) => {
        fire = listener;
        return source;
      },
    };
    captureUnexpectedResponse(source, handlers);
    const dataListeners: Array<(chunk: Buffer) => void> = [];
    const endListeners: Array<() => void> = [];
    fire?.(
      { destroy: () => (destroyed = true) },
      {
        statusCode,
        on: (event: "data" | "end", listener: unknown) => {
          if (event === "data") {
            dataListeners.push(listener as (chunk: Buffer) => void);
          } else {
            endListeners.push(listener as () => void);
          }
          return undefined;
        },
      },
    );
    for (const l of dataListeners) {
      l(Buffer.from(body));
    }
    for (const l of endListeners) {
      l();
    }
    return { errors, destroyed: () => destroyed };
  }

  it("surfaces the API's JSON error body — message inline, full object as data", () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: "API key not valid. Please pass a valid API key.",
        status: "PERMISSION_DENIED",
      },
    });
    const { errors, destroyed } = reject(403, body);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe(
      "upstream rejected the connection (HTTP 403): API key not valid. Please pass a valid API key.",
    );
    expect((errors[0].data as { error: { status: string } }).error.status).toBe(
      "PERMISSION_DENIED",
    );
    expect(destroyed()).toBe(true);
  });

  it("passes a non-JSON body through as capped raw text", () => {
    const { errors } = reject(502, "Bad Gateway");
    expect(errors[0].message).toBe("upstream rejected the connection (HTTP 502): Bad Gateway");
    expect(errors[0].data).toBe("Bad Gateway");
  });

  it("reports status alone when the body is empty", () => {
    const { errors } = reject(401, "");
    expect(errors[0].message).toBe("upstream rejected the connection (HTTP 401)");
    expect(errors[0].data).toBeUndefined();
  });
});
