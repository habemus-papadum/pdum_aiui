import {
  type ChannelErrorMessage,
  type ChannelResponse,
  type ChunkDescriptor,
  decodeFrame,
  type HelloMeta,
  jsonCodec,
  PROTOCOL_VERSION as SERVER_PROTOCOL_VERSION,
} from "@habemus-papadum/aiui-claude-channel";
import {
  type LoweredPromptMessage as ChannelLoweredPromptMessage,
  REALTIME_VOICE_RATE,
  type SpeechMessage,
} from "@habemus-papadum/aiui-claude-channel/internal";
import { describe, expect, expectTypeOf, it } from "vitest";
import { REALTIME_PCM_MIME, REALTIME_PCM_RATE } from "./audio";
import type { ClientMeta } from "./instrumentation";
import {
  type Ack,
  type LoweredPromptMessage as ClientLoweredPromptMessage,
  connectIntentSocket,
  type ErrorMessage,
  encodeFrame,
  encodeJsonPayload,
  type FrameChunk,
  isErrorMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "./protocol";
import type { SpeechClip } from "./speech";
import { fakeSocketFactory } from "./test-support/fake-socket";

describe("frame encoding (cross-checked against the channel package)", () => {
  it("targets the same protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(SERVER_PROTOCOL_VERSION);
  });

  it("produces frames the server-side decoder accepts", () => {
    const frame = encodeFrame(
      { v: PROTOCOL_VERSION, kind: "data", threadId: "t-9", fin: true },
      encodeJsonPayload({ text: "hello" }),
    );
    const { envelope, payload } = decodeFrame(frame);
    expect(envelope).toEqual({ v: 1, kind: "data", threadId: "t-9", fin: true });
    expect(jsonCodec.decode(payload)).toEqual({ text: "hello" });
  });

  it("encodes a payload-less frame as header only", () => {
    const frame = encodeFrame({ v: PROTOCOL_VERSION, kind: "hello", format: "text-concat" });
    const { envelope, payload } = decodeFrame(frame);
    expect(envelope.format).toBe("text-concat");
    expect(payload.length).toBe(0);
  });
});

describe("connectIntentSocket", () => {
  it("completes the hello then sends acked data frames", async () => {
    const { factory, sent } = fakeSocketFactory(() => ({ ok: true }));
    const socket = await connectIntentSocket("ws://fake/ws", "text-concat", factory);

    const ack = await socket.send("t-1", { text: "hi" }, true);
    expect(ack.ok).toBe(true);
    expect(sent).toHaveLength(2);

    const hello = decodeFrame(sent[0]);
    expect(hello.envelope).toMatchObject({ kind: "hello", format: "text-concat" });
    expect(hello.envelope).not.toHaveProperty("meta");
    const data = decodeFrame(sent[1]);
    expect(data.envelope).toMatchObject({ kind: "data", threadId: "t-1", fin: true });
    expect(jsonCodec.decode(data.payload)).toEqual({ text: "hi" });
  });

  it("carries the client meta on the hello envelope", async () => {
    const { factory, sent } = fakeSocketFactory(() => ({ ok: true }));
    const meta = {
      tab: { url: "http://localhost:5199/", title: "spectra", chromeTabId: 7 },
      source: { root: "/repo/app" },
    };
    await connectIntentSocket("ws://fake/ws", "text-concat", factory, meta);
    const hello = decodeFrame(sent[0]);
    expect(hello.envelope).toMatchObject({ kind: "hello", format: "text-concat", meta });
  });

  it("rejects when the server refuses the format", async () => {
    const { factory } = fakeSocketFactory(() => ({ ok: false, error: "unknown format" }));
    await expect(connectIntentSocket("ws://fake/ws", "nope", factory)).rejects.toThrow(
      "unknown format",
    );
  });
});

describe("intent-v1 chunks and server pushes", () => {
  it("tags an events chunk with a JSON payload", async () => {
    const { factory, sent } = fakeSocketFactory(() => ({ ok: true }));
    const socket = await connectIntentSocket("ws://fake/ws", "intent-v1", factory);
    await socket.sendChunk("t-1", { kind: "events" }, { events: [{ type: "thread-open" }] }, false);
    const { envelope, payload } = decodeFrame(sent[1]);
    expect(envelope).toMatchObject({
      kind: "data",
      threadId: "t-1",
      fin: false,
      chunk: { kind: "events" },
    });
    expect(jsonCodec.decode(payload)).toEqual({ events: [{ type: "thread-open" }] });
  });

  it("carries raw attachment bytes verbatim (no base64) with an id + mime", async () => {
    const { factory, sent } = fakeSocketFactory(() => ({ ok: true }));
    const socket = await connectIntentSocket("ws://fake/ws", "intent-v1", factory);
    // A tiny PNG signature is enough to prove the bytes cross unchanged.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await socket.sendAttachment(
      "t-1",
      { kind: "attachment", id: "shot_1", mime: "image/png" },
      bytes,
    );
    const { envelope, payload } = decodeFrame(sent[1]);
    expect(envelope).toMatchObject({
      kind: "data",
      threadId: "t-1",
      chunk: { kind: "attachment", id: "shot_1", mime: "image/png" },
    });
    expect([...payload]).toEqual([...bytes]);
  });

  it("marks the thread's final frame with fin", async () => {
    const { factory, sent } = fakeSocketFactory(() => ({ ok: true }));
    const socket = await connectIntentSocket("ws://fake/ws", "intent-v1", factory);
    await socket.send("t-1", undefined, true);
    expect(decodeFrame(sent[1]).envelope.fin).toBe(true);
  });

  it("routes `kind`-bearing server messages to onServerMessage, not the ack path", async () => {
    const { factory, push } = fakeSocketFactory(() => ({ ok: true }));
    const socket = await connectIntentSocket("ws://fake/ws", "intent-v1", factory);
    const pushes: unknown[] = [];
    socket.onServerMessage((msg) => pushes.push(msg));

    // A push must not steal the ack a pending send is waiting for.
    const ackPromise = socket.sendChunk("t-1", { kind: "events" }, { events: [] }, false);
    push({ kind: "lowered", threadId: "t-1", events: [{ type: "note", text: "hi" }] });
    const ack = await ackPromise;

    expect(ack.ok).toBe(true);
    expect(pushes).toEqual([
      { kind: "lowered", threadId: "t-1", events: [{ type: "note", text: "hi" }] },
    ]);
  });

  it("delivers a server error push through onServerMessage as an ErrorMessage", async () => {
    const { factory, push } = fakeSocketFactory(() => ({ ok: true }));
    const socket = await connectIntentSocket("ws://fake/ws", "intent-v1", factory);
    const errors: ServerMessage[] = [];
    socket.onServerMessage((msg) => {
      if (isErrorMessage(msg)) {
        errors.push(msg);
      }
    });
    push({
      kind: "error",
      threadId: "t-1",
      source: "transcription",
      message: "transcription failed (401)",
      detail: "check OPENAI_API_KEY",
    });
    expect(errors).toEqual([
      {
        kind: "error",
        threadId: "t-1",
        source: "transcription",
        message: "transcription failed (401)",
        detail: "check OPENAI_API_KEY",
      },
    ]);
  });
});

describe("connection-loss detection (the client-detected half of the error surface)", () => {
  it("synthesizes a connection error push when the server drops an established socket", async () => {
    const { factory, drop } = fakeSocketFactory(() => ({ ok: true }));
    const socket = await connectIntentSocket("ws://fake/ws", "intent-v1", factory);
    const errors: ServerMessage[] = [];
    socket.onServerMessage((msg) => {
      if (isErrorMessage(msg)) {
        errors.push(msg);
      }
    });

    drop(1012, "channel reload"); // the server-initiated drop (e.g. a reload)

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "error", source: "connection" });
    // The close reason rides the message so the toast can say WHY.
    expect(errors[0].message).toContain("channel reload");
    // Sends after the drop settle with a failure ack rather than hanging.
    const ack = await socket.send("t-1", { text: "late" }, false);
    expect(ack).toMatchObject({ ok: false });
  });

  it("stays silent when the client itself closes the socket (a finished turn)", async () => {
    const { factory } = fakeSocketFactory(() => ({ ok: true }));
    const socket = await connectIntentSocket("ws://fake/ws", "intent-v1", factory);
    const pushes: ServerMessage[] = [];
    socket.onServerMessage((msg) => pushes.push(msg));

    socket.close(); // the deliberate teardown after fin/cancel

    expect(pushes).toEqual([]);
  });
});

// The wire mirrors this package deliberately reimplements (protocol.ts is a
// dependency-free twin of the channel's frame/channel/intent-v1 types) can only
// drift silently — a comment says "change both together", nothing enforces it.
// These type-level assertions (checked at `tsc`, not runtime) turn every mirror
// into a compile error the moment the two sides disagree. See docs/proposals/
// code-review-pass2-s1-mirrors.md.
describe("wire-mirror drift guards (compile-time; the channel is a devDependency)", () => {
  it("ChunkDescriptor ≡ the runtime's FrameChunk union", () => {
    expectTypeOf<FrameChunk>().toEqualTypeOf<ChunkDescriptor>();
  });

  it("ChannelErrorMessage ≡ ErrorMessage over the shared fields, with none unmirrored", () => {
    expectTypeOf<
      Pick<ErrorMessage, "kind" | "threadId" | "source" | "message" | "detail" | "data">
    >().toEqualTypeOf<
      Pick<ChannelErrorMessage, "kind" | "threadId" | "source" | "message" | "detail" | "data">
    >();
    // A new channel field would land here (Exclude ≠ never) and fail the build.
    expectTypeOf<
      Exclude<
        keyof ChannelErrorMessage,
        "kind" | "threadId" | "source" | "message" | "detail" | "data"
      >
    >().toEqualTypeOf<never>();
  });

  it("every hello ClientMeta satisfies the channel's HelloMeta envelope", () => {
    // Assignability, NOT equality: the client narrows `intent` to an object
    // where the server keeps it `unknown` (its trust boundary) — by design.
    expectTypeOf<ClientMeta>().toMatchTypeOf<HelloMeta>();
  });

  it("a collectClientMeta()-shaped meta survives the channel encode/decode intact", () => {
    // protocol.test.ts runs without jsdom, so build the shape by hand rather
    // than calling collectClientMeta() (which needs a DOM). Typing it ClientMeta
    // ties the literal to the producer's contract.
    const meta: ClientMeta = {
      tab: { url: "http://localhost:5199/", title: "spectra", chromeTabId: 7 },
      source: { root: "/repo/app" },
      actor: "agent",
    };
    const frame = encodeFrame({ v: PROTOCOL_VERSION, kind: "hello", format: "intent-v1", meta });
    const { envelope } = decodeFrame(frame);
    expect(envelope.meta).toEqual(meta);
  });

  it("LoweredPromptMessage twins agree over kind/threadId/prompt/spans/meta", () => {
    expectTypeOf<
      Pick<ClientLoweredPromptMessage, "kind" | "threadId" | "prompt" | "spans" | "meta">
    >().toEqualTypeOf<
      Pick<ChannelLoweredPromptMessage, "kind" | "threadId" | "prompt" | "spans" | "meta">
    >();
    // The next additive server field (this is how `spans` slipped) breaks here.
    expectTypeOf<
      Exclude<keyof ChannelLoweredPromptMessage, "kind" | "threadId" | "prompt" | "spans" | "meta">
    >().toEqualTypeOf<never>();
  });

  it("Ack mirrors ChannelResponse with no unmirrored server field", () => {
    expectTypeOf<
      Pick<Ack, "ok" | "threadId" | "closed" | "error" | "fatal" | "debug">
    >().toEqualTypeOf<
      Pick<ChannelResponse, "ok" | "threadId" | "closed" | "error" | "fatal" | "debug">
    >();
    expectTypeOf<Exclude<keyof ChannelResponse, keyof Ack>>().toEqualTypeOf<never>();
  });

  it("SpeechClip is exactly the SpeechMessage payload subset", () => {
    expectTypeOf<
      Pick<SpeechMessage, "id" | "mime" | "data" | "label">
    >().toEqualTypeOf<SpeechClip>();
  });

  it("the 24 kHz PCM contract matches the channel's realtime voice rate", () => {
    expect(REALTIME_PCM_RATE).toBe(REALTIME_VOICE_RATE);
    expect(REALTIME_PCM_MIME).toBe(`audio/pcm;rate=${REALTIME_VOICE_RATE}`);
  });
});
