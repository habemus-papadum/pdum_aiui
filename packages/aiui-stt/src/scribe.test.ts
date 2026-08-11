/**
 * scribe.test.ts — the ported Scribe wire facts, pinned: URL construction
 * over a minted connect URL, FIFO correlation, cumulative partials across
 * vendor self-commits, the fatal commit floor, the idle keepalive, and the
 * config-echo discipline. Each pin mirrors a live-verified behavior recorded
 * in the channel's engine (see scribe.ts's header).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCRIBE_KEEPALIVE_MS, scribeTransport } from "./scribe";
import { fakeSocket, pcmMs, recordingCallbacks } from "./test-support/fakes";
import type { SttConnection } from "./types";

const TOKEN_URL =
  "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&token=sutkn_fixture";

async function openScribe(
  options: Parameters<typeof scribeTransport>[0] = { connectUrl: async () => TOKEN_URL },
) {
  const socket = fakeSocket();
  const record = recordingCallbacks();
  const transport = scribeTransport({
    connectUrl: async () => TOKEN_URL,
    socketFactory: socket.factory,
    now: () => 1000,
    ...options,
  });
  const connection = await transport.open(record.callbacks);
  return { socket, record, connection, transport };
}

function ready(socket: ReturnType<typeof fakeSocket>, config: object = {}): void {
  socket.message({ message_type: "session_started", config });
}

describe("scribeTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds the connect URL over the minted one: engine params asserted, token preserved", async () => {
    const { socket } = await openScribe({
      connectUrl: async () => TOKEN_URL,
      language: "en",
      keyterms: ["morphogen", "aiui"],
    });
    const url = new URL(socket.url() ?? "");
    expect(url.searchParams.get("token")).toBe("sutkn_fixture");
    expect(url.searchParams.get("audio_format")).toBe("pcm_24000");
    expect(url.searchParams.get("include_timestamps")).toBe("true");
    expect(url.searchParams.get("no_verbatim")).toBe("true");
    expect(url.searchParams.get("language_code")).toBe("en");
    // Repeatable PLAIN params — the bracket form is silently dropped upstream.
    expect(url.searchParams.getAll("keyterms")).toEqual(["morphogen", "aiui"]);
  });

  it("queues audio until session_started, then flushes in order", async () => {
    const { socket, connection } = await openScribe();
    connection.appendAudio(0, pcmMs(600));
    expect(socket.sent).toHaveLength(0); // gated — not ready yet
    ready(socket);
    expect(socket.sentJson()).toMatchObject([
      { message_type: "input_audio_chunk", commit: false, sample_rate: 24000 },
    ]);
  });

  it("diffs the config echo and reports mismatches (silence is never success)", async () => {
    const { socket, record } = await openScribe();
    ready(socket, { model_id: "scribe_v2_realtime", include_timestamps: false, no_verbatim: true });
    expect(record.diagnostics.some((d) => d.kind === "config-echo")).toBe(true);
    expect(record.diagnostics).toContainEqual({
      kind: "config-mismatch",
      param: "include_timestamps",
      requested: true,
      echoed: false,
    });
  });

  it("binds cumulative partials to the streaming segment and completes FIFO with rebased words", async () => {
    const { socket, record, connection } = await openScribe();
    ready(socket);
    connection.appendAudio(7, pcmMs(600));
    socket.message({ message_type: "partial_transcript", text: "hello" });
    expect(record.deltas).toEqual([[7, "hello"]]);

    connection.commit(7);
    const frames = socket.sentJson();
    expect(frames.at(-1)).toMatchObject({ commit: true });

    socket.message({
      message_type: "committed_transcript",
      text: "hello world",
    });
    expect(record.finals).toHaveLength(0); // the plain view is ignored — the twin does the work

    socket.message({
      message_type: "committed_transcript_with_timestamps",
      text: "hello world",
      words: [
        { text: "hello", start: 0.1, end: 0.4, logprob: -0.05 },
        { text: " ", start: 0.4, end: 0.5, type: "spacing" },
        { text: "world", start: 0.5, end: 0.9, logprob: -0.2 },
      ],
    });
    expect(record.finals).toHaveLength(1);
    const [segment, final] = record.finals[0];
    expect(segment).toBe(7);
    expect(final.text).toBe("hello world");
    expect(final.model).toBe("scribe_v2_realtime");
    expect(final.words).toEqual([
      { text: "hello", startMs: 100, endMs: 400, logprob: -0.05 },
      { text: "world", startMs: 500, endMs: 900, logprob: -0.2 },
    ]);
  });

  it("rebases word timestamps by the segment's audio base (Scribe's timeline is cumulative)", async () => {
    const { socket, record, connection } = await openScribe();
    ready(socket);
    // Segment 0 streams 1000 ms, commits, finals.
    connection.appendAudio(0, pcmMs(1000));
    connection.commit(0);
    socket.message({
      message_type: "committed_transcript_with_timestamps",
      text: "one",
      words: [],
    });
    // Segment 1 starts at cumulative 1000 ms; Scribe stamps words on that axis.
    connection.appendAudio(1, pcmMs(600));
    connection.commit(1);
    socket.message({
      message_type: "committed_transcript_with_timestamps",
      text: "two",
      words: [{ text: "two", start: 1.2, end: 1.5 }],
    });
    expect(record.finals[1][1].words).toEqual([{ text: "two", startMs: 200, endMs: 500 }]);
  });

  it("REFUSES an under-floor commit: nothing on the wire, the segment settles locally", async () => {
    const { socket, record, connection } = await openScribe();
    ready(socket);
    connection.appendAudio(0, pcmMs(200)); // under the 500 ms floor
    const framesBefore = socket.sent.length;
    connection.commit(0);
    expect(socket.sent.length).toBe(framesBefore); // no commit frame — fatal upstream
    expect(record.finals).toEqual([[0, { text: "", latencyMs: 0, model: "scribe_v2_realtime" }]]);
  });

  it("accumulates a vendor self-commit and keeps the caller's cumulative-delta contract", async () => {
    const { socket, record, connection } = await openScribe();
    ready(socket);
    connection.appendAudio(3, pcmMs(1000));
    socket.message({ message_type: "partial_transcript", text: "the quick" });
    // Scribe caps the utterance ITSELF — no commit from us, FIFO empty.
    socket.message({
      message_type: "committed_transcript_with_timestamps",
      text: "the quick brown",
      words: [{ text: "the", start: 0, end: 0.2 }],
    });
    expect(record.diagnostics).toContainEqual({
      kind: "vendor-commit",
      segment: 3,
      chars: "the quick brown".length,
      words: 1,
    });
    // The caller's view stays cumulative across the vendor's partial reset.
    expect(record.deltas.at(-1)).toEqual([3, "the quick brown"]);
    socket.message({ message_type: "partial_transcript", text: "fox" });
    expect(record.deltas.at(-1)).toEqual([3, "the quick brown fox"]);

    // The self-commit consumed the vendor buffer — our floor meter followed it
    // to zero, so this commit is under-floor and resolves LOCALLY, still
    // owning everything the vendor closed inside the segment.
    connection.commit(3);
    expect(record.finals).toHaveLength(1);
    expect(record.finals[0][0]).toBe(3);
    expect(record.finals[0][1].text).toBe("the quick brown");
    expect(record.finals[0][1].words).toEqual([{ text: "the", startMs: 0, endMs: 200 }]);
  });

  it("attributes an error to the FIFO head, session-wide when nothing is in flight", async () => {
    const { socket, record, connection } = await openScribe();
    ready(socket);
    socket.message({ message_type: "quota_exceeded", error: "quota exceeded" });
    expect(record.errors).toEqual([["quota exceeded", undefined]]);

    connection.appendAudio(0, pcmMs(600));
    connection.commit(0);
    socket.message({ message_type: "transcriber_error", error: "upstream fault" });
    expect(record.errors.at(-1)).toEqual(["upstream fault", 0]);
  });

  it("finalizes outstanding segments loudly on a mid-flight close, with the vendor's reason", async () => {
    const { socket, record, connection } = await openScribe();
    ready(socket);
    connection.appendAudio(0, pcmMs(600));
    connection.commit(0);
    socket.close(1000, "commit_throttled");
    expect(record.errors).toEqual([["realtime session closed (1000: commit_throttled)", 0]]);
  });

  it("drain resolves on the last final; a timeout names the outstanding ordinals", async () => {
    vi.useRealTimers();
    const { socket, record, connection } = await openScribe();
    ready(socket);
    connection.appendAudio(0, pcmMs(600));
    connection.commit(0);
    connection.appendAudio(1, pcmMs(600));
    connection.commit(1);
    const drained = connection.drain(50);
    socket.message({
      message_type: "committed_transcript_with_timestamps",
      text: "one",
      words: [],
    });
    expect(await drained).toEqual([1]); // segment 1 still outstanding at timeout
    expect(record.finals.map(([s]) => s)).toEqual([0]);
  });

  it("holds the idle socket open with empty keepalive chunks", async () => {
    const { socket } = await openScribe();
    ready(socket);
    expect(socket.sent).toHaveLength(0);
    vi.advanceTimersByTime(SCRIBE_KEEPALIVE_MS);
    expect(socket.sentJson()).toEqual([
      { message_type: "input_audio_chunk", audio_base_64: "", commit: false, sample_rate: 24000 },
    ]);
    vi.advanceTimersByTime(SCRIBE_KEEPALIVE_MS);
    expect(socket.sent).toHaveLength(2); // re-arms itself
  });

  it("reports unknown message types instead of dropping them", async () => {
    const { socket, record } = await openScribe();
    ready(socket);
    socket.message({ message_type: "brand_new_thing", data: 1 });
    expect(record.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "unhandled", messageType: "brand_new_thing" }),
    );
  });

  it("discard drops the local binding; late partials stop leaking", async () => {
    const { socket, record, connection } = await openScribe();
    ready(socket);
    connection.appendAudio(0, pcmMs(100));
    connection.discard(0);
    socket.message({ message_type: "partial_transcript", text: "stray" });
    expect(record.deltas).toEqual([]); // no streaming segment to bind to
  });
});

// Keeps the helper honest: a connection is what open() resolves to.
it("open resolves to a live connection (typecheck anchor)", async () => {
  const socket = fakeSocket();
  const record = recordingCallbacks();
  const connection: SttConnection = await scribeTransport({
    connectUrl: async () => TOKEN_URL,
    socketFactory: socket.factory,
  }).open(record.callbacks);
  connection.close();
  expect(socket.closed()).toBe(true);
});
