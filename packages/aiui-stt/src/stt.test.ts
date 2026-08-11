/**
 * stt.test.ts — the handle's own contracts: the mint-window queue (hold the
 * key and talk immediately, lose nothing), push-to-talk frame routing over
 * an injected AudioSource (warm mic, gated wire, tail flushed before the
 * commit), the status lifecycle, and loud settlement when a connect fails
 * with commits queued.
 */
import { describe, expect, it } from "vitest";
import { createStt } from "./stt";
import type { AudioSource, SttCallbacks, SttConnection, SttTransport } from "./types";

type Op =
  | { op: "append"; segment: number; bytes: number }
  | { op: "commit"; segment: number }
  | { op: "discard"; segment: number }
  | { op: "close" };

function stubTransport() {
  const ops: Op[] = [];
  let callbacks: SttCallbacks | undefined;
  let resolveOpen: ((connection: SttConnection) => void) | undefined;
  let rejectOpen: ((error: Error) => void) | undefined;
  const connection: SttConnection = {
    appendAudio: (segment, bytes) => ops.push({ op: "append", segment, bytes: bytes.length }),
    commit: (segment) => ops.push({ op: "commit", segment }),
    discard: (segment) => ops.push({ op: "discard", segment }),
    drain: async () => [],
    close: () => ops.push({ op: "close" }),
  };
  const transport: SttTransport = {
    name: "stub",
    capabilities: {
      wordTimestamps: false,
      wordLogprobs: false,
      languageHint: false,
      keyterms: false,
      vendorVad: false,
    },
    open(cb) {
      callbacks = cb;
      return new Promise<SttConnection>((resolve, reject) => {
        resolveOpen = () => resolve(connection);
        rejectOpen = reject;
      });
    },
  };
  return {
    transport,
    ops,
    connection,
    callbacks: () => callbacks,
    settle: () => resolveOpen?.(connection),
    fail: (message: string) => rejectOpen?.(new Error(message)),
  };
}

function stubAudio(): AudioSource & {
  emit: (bytes: Uint8Array) => void;
  flushed: number[];
  stopped: () => boolean;
} {
  let sink: ((pcm16: Uint8Array) => void) | undefined;
  let stopped = false;
  const flushed: number[] = [];
  return {
    sampleRate: 24000,
    async start(onFrame) {
      sink = onFrame;
    },
    stop() {
      stopped = true;
      sink = undefined;
    },
    flush() {
      flushed.push(1);
      sink?.(new Uint8Array(4)); // the buffered tail
    },
    emit: (bytes) => sink?.(bytes),
    flushed,
    stopped: () => stopped,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createStt", () => {
  it("queues segment ops through the mint window and flushes in order", async () => {
    const t = stubTransport();
    const stt = createStt({ transport: t.transport });
    const segment = stt.beginSegment();
    stt.appendAudio(new Uint8Array(10));
    stt.endSegment();
    expect(t.ops).toEqual([]); // still minting
    t.settle();
    await tick();
    expect(t.ops).toEqual([
      { op: "append", segment, bytes: 10 },
      { op: "commit", segment },
    ]);
  });

  it("walks idle → connecting → ready, and closed on close", async () => {
    const t = stubTransport();
    const stt = createStt({ transport: t.transport });
    const seen: string[] = [];
    stt.subscribe((event) => {
      if (event.type === "status") {
        seen.push(event.status);
      }
    });
    expect(stt.status()).toBe("idle");
    const connectPromise = stt.connect();
    expect(stt.status()).toBe("connecting");
    t.settle();
    await connectPromise;
    expect(stt.status()).toBe("ready");
    stt.close();
    expect(stt.status()).toBe("closed");
    expect(seen).toEqual(["connecting", "ready", "closed"]);
    expect(t.ops.at(-1)).toEqual({ op: "close" });
  });

  it("routes source frames only while a segment is open (warm mic, gated wire)", async () => {
    const t = stubTransport();
    const audio = stubAudio();
    const stt = createStt({ transport: t.transport, audio });
    const connectPromise = stt.connect();
    t.settle();
    await connectPromise;

    audio.emit(new Uint8Array(8)); // no open segment — dropped
    const segment = stt.beginSegment();
    await tick(); // let the source's start() settle
    audio.emit(new Uint8Array(16));
    stt.endSegment();
    audio.emit(new Uint8Array(32)); // between segments — dropped

    const appends = t.ops.filter((op) => op.op === "append");
    expect(appends).toEqual([
      { op: "append", segment, bytes: 16 },
      { op: "append", segment, bytes: 4 }, // the flushed tail
    ]);
    // The tail flush lands BEFORE the commit, so the commit covers it.
    expect(t.ops.at(-1)).toEqual({ op: "commit", segment });
    expect(audio.flushed).toHaveLength(1);
  });

  it("cancelSegment during the mint window drops that segment's queued frames", async () => {
    const t = stubTransport();
    const stt = createStt({ transport: t.transport });
    const first = stt.beginSegment();
    stt.appendAudio(new Uint8Array(10));
    stt.cancelSegment();
    const second = stt.beginSegment();
    stt.appendAudio(new Uint8Array(20));
    stt.endSegment();
    t.settle();
    await tick();
    expect(t.ops).toEqual([
      { op: "discard", segment: first },
      { op: "append", segment: second, bytes: 20 },
      { op: "commit", segment: second },
    ]);
  });

  it("settles queued commits loudly when the transport fails to open", async () => {
    const t = stubTransport();
    const errors: Array<[string, number | undefined]> = [];
    const stt = createStt({
      transport: t.transport,
      callbacks: { onError: (message, segment) => errors.push([message, segment]) },
    });
    const segment = stt.beginSegment();
    stt.endSegment();
    t.fail("mint 403");
    await tick();
    expect(stt.status()).toBe("error");
    expect(errors).toEqual([
      [expect.stringContaining("mint 403") as unknown as string, segment],
      [expect.stringContaining("mint 403") as unknown as string, undefined],
    ]);
  });

  it("fans engine callbacks out to creation-time observers AND subscribers", async () => {
    const t = stubTransport();
    const viaCallbacks: string[] = [];
    const stt = createStt({
      transport: t.transport,
      callbacks: { onDelta: (_s, text) => viaCallbacks.push(text) },
    });
    const viaEvents: string[] = [];
    stt.subscribe((event) => {
      if (event.type === "delta") {
        viaEvents.push(event.text);
      }
    });
    const connectPromise = stt.connect();
    t.settle();
    await connectPromise;
    t.callbacks()?.onDelta(0, "hello");
    expect(viaCallbacks).toEqual(["hello"]);
    expect(viaEvents).toEqual(["hello"]);
  });

  it("ends a stale open segment when a new one begins (push-to-talk has one boundary)", async () => {
    const t = stubTransport();
    const stt = createStt({ transport: t.transport });
    const connectPromise = stt.connect();
    t.settle();
    await connectPromise;
    const first = stt.beginSegment();
    const second = stt.beginSegment(); // the missed key-up
    stt.endSegment();
    expect(t.ops).toEqual([
      { op: "commit", segment: first },
      { op: "commit", segment: second },
    ]);
  });

  it("stops the audio source on close", async () => {
    const t = stubTransport();
    const audio = stubAudio();
    const stt = createStt({ transport: t.transport, audio });
    stt.beginSegment();
    await tick();
    stt.close();
    expect(audio.stopped()).toBe(true);
  });
});
