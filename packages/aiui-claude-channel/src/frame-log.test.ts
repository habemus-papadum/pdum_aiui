import { describe, expect, it } from "vitest";
import { encodeFrame, PROTOCOL_VERSION } from "./frame";
import { ackEntry, createFrameLog, type FrameLogEntry, inboundEntry, pushEntry } from "./frame-log";

const enc = new TextEncoder();

describe("createFrameLog", () => {
  it("stamps monotonically increasing seqs and serves a since-filtered snapshot", () => {
    const log = createFrameLog();
    log.record({ dir: "in", label: "hello" });
    log.record({ dir: "out", label: "ack" });
    log.record({ dir: "in", label: "fin" });

    const all = log.snapshot();
    expect(all.seq).toBe(3);
    expect(all.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all.entries.map((e) => e.label)).toEqual(["hello", "ack", "fin"]);
    expect(all.entries.every((e) => typeof e.at === "string")).toBe(true);

    // A poller echoing the last seq it saw gets only what's new.
    expect(log.snapshot(2).entries.map((e) => e.seq)).toEqual([3]);
    expect(log.snapshot(3).entries).toEqual([]);
  });

  it("bounds the ring but never resets seq, so a since cursor survives eviction", () => {
    const log = createFrameLog({ limit: 3 });
    for (let i = 0; i < 5; i++) {
      log.record({ dir: "in", label: `frame ${i}` });
    }
    const { seq, entries } = log.snapshot();
    expect(seq).toBe(5);
    expect(entries.map((e) => e.seq)).toEqual([3, 4, 5]); // oldest two evicted
    expect(log.snapshot(4).entries.map((e) => e.label)).toEqual(["frame 4"]);
  });

  it("feeds every entry to the sink, and survives a sink that throws", () => {
    const seen: FrameLogEntry[] = [];
    const log = createFrameLog({
      sink: (entry) => {
        seen.push(entry);
        throw new Error("broken sink");
      },
    });
    log.record({ dir: "in", label: "hello" });
    log.record({ dir: "out", label: "ack", data: { ok: true } });
    expect(seen.map((e) => e.label)).toEqual(["hello", "ack"]);
    expect(log.snapshot().seq).toBe(2); // the throw never lost an entry
  });
});

describe("inboundEntry / ackEntry / pushEntry", () => {
  it("labels a hello with its envelope (meta inline)", () => {
    const frame = encodeFrame({
      v: PROTOCOL_VERSION,
      kind: "hello",
      format: "intent-v1",
      meta: { actor: "agent" },
    });
    expect(inboundEntry(frame)).toEqual({
      dir: "in",
      label: "hello",
      data: { v: PROTOCOL_VERSION, kind: "hello", format: "intent-v1", meta: { actor: "agent" } },
    });
  });

  it("parses JSON chunk payloads and reduces binary ones to byte counts", () => {
    const events = encodeFrame(
      { v: PROTOCOL_VERSION, kind: "data", threadId: "t", chunk: { kind: "events" } },
      enc.encode(JSON.stringify({ events: [{ at: 1, type: "armed", on: true }] })),
    );
    expect(inboundEntry(events)).toEqual({
      dir: "in",
      label: "chunk events",
      threadId: "t",
      data: { events: [{ at: 1, type: "armed", on: true }] },
    });

    const shot = encodeFrame(
      {
        v: PROTOCOL_VERSION,
        kind: "data",
        threadId: "t",
        chunk: { kind: "attachment", id: "shot_3", mime: "image/png" },
      },
      new Uint8Array(64),
    );
    expect(inboundEntry(shot)).toEqual({
      dir: "in",
      label: "chunk attachment shot_3 (image/png)",
      threadId: "t",
      bytes: 64,
    });

    const audio = encodeFrame(
      {
        v: PROTOCOL_VERSION,
        kind: "data",
        threadId: "t",
        chunk: { kind: "audio", id: "seg_1", seq: 4, mime: "audio/pcm" },
      },
      new Uint8Array(1920),
    );
    expect(inboundEntry(audio)).toEqual({
      dir: "in",
      label: "chunk audio seg_1 #4",
      threadId: "t",
      bytes: 1920,
    });
  });

  it("labels the bare chunkless fin, chunkless data, and malformed frames", () => {
    const fin = encodeFrame({ v: PROTOCOL_VERSION, kind: "data", threadId: "t", fin: true });
    expect(inboundEntry(fin)).toEqual({ dir: "in", label: "fin", threadId: "t" });

    // A legacy (text-concat) payload: this layer can't know its codec.
    const legacy = encodeFrame(
      { v: PROTOCOL_VERSION, kind: "data", threadId: "t" },
      enc.encode('{"text":"hi"}'),
    );
    expect(inboundEntry(legacy)).toEqual({ dir: "in", label: "data", threadId: "t", bytes: 13 });

    expect(inboundEntry(new Uint8Array([1, 2]))).toEqual({
      dir: "in",
      label: "malformed frame",
      bytes: 2,
    });
  });

  it("records acks verbatim and tags pushes by kind", () => {
    expect(ackEntry({ ok: true, threadId: "t", closed: true })).toEqual({
      dir: "out",
      label: "ack",
      threadId: "t",
      data: { ok: true, threadId: "t", closed: true },
    });
    expect(pushEntry({ kind: "lowered", threadId: "t", events: [] })).toEqual({
      dir: "out",
      label: "push lowered",
      threadId: "t",
      data: { kind: "lowered", threadId: "t", events: [] },
    });
  });

  it("replaces a speech push's base64 data with its length (never megabytes in the ring)", () => {
    const base64 = "A".repeat(4096);
    const entry = pushEntry({
      kind: "speech",
      threadId: "t",
      id: "ack_0",
      mime: "audio/mpeg",
      data: base64,
      label: "sent",
    });
    expect(entry.label).toBe("push speech");
    expect(entry.data).toEqual({
      kind: "speech",
      threadId: "t",
      id: "ack_0",
      mime: "audio/mpeg",
      data: 4096,
      label: "sent",
    });
  });
});
