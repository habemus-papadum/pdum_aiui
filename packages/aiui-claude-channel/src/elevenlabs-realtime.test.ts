import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkConfigEcho,
  convertWords,
  ELEVENLABS_COMMIT_FLOOR_MS,
  ELEVENLABS_KEEPALIVE_MS,
  isErrorType,
  openElevenLabsRealtimeSession,
} from "./elevenlabs-realtime";
import { type FakeUpstream, fakeUpstream } from "./fake-upstream";
import type { RealtimeCallbacks, RealtimeDiagnostic, RealtimeResult } from "./realtime";

const noopCallbacks = (): RealtimeCallbacks => ({
  onDelta: () => {},
  onFinal: () => {},
  onError: () => {},
});

/** `n` ms of PCM16 @ 24 kHz mono as zeroed bytes (48 bytes/ms). */
const audioMs = (n: number): Uint8Array => new Uint8Array(n * 48);

/** Exactly the commit floor of audio — enough that a following `commit` actually flushes. */
const FLOOR_AUDIO = audioMs(ELEVENLABS_COMMIT_FLOOR_MS);

/** A committed_transcript_with_timestamps server event with a one-word transcript. */
const withTimestamps = (text: string, words?: Array<Record<string, unknown>>) => ({
  message_type: "committed_transcript_with_timestamps",
  text,
  words: words ?? [{ text, start: 0, end: 1, type: "word" }],
});

// ── the session state machine, in isolation ──────────────────────────────────

describe("openElevenLabsRealtimeSession", () => {
  function collect(up: FakeUpstream, now: () => number = () => 0) {
    const deltas: Array<{ segment: number; text: string }> = [];
    const finals: Array<{ segment: number } & RealtimeResult> = [];
    const errors: Array<{ message: string; segment?: number }> = [];
    const diagnostics: RealtimeDiagnostic[] = [];
    const cb: RealtimeCallbacks = {
      onDelta: (segment, text) => deltas.push({ segment, text }),
      onFinal: (segment, result) => finals.push({ segment, ...result }),
      onError: (message, segment) =>
        errors.push({ message, ...(segment !== undefined ? { segment } : {}) }),
      onDiagnostic: (event) => diagnostics.push(event),
    };
    const session = openElevenLabsRealtimeSession(
      { apiKey: "k", socketFactory: up.factory, now },
      cb,
    );
    return { session, deltas, finals, errors, diagnostics };
  }

  it("puts the full session config in the connect URL (overrides + repeatable keyterms)", () => {
    const up = fakeUpstream();
    openElevenLabsRealtimeSession(
      {
        apiKey: "k",
        socketFactory: up.factory,
        modelId: () => "scribe_v2_realtime_ja",
        language: () => "ja",
        keyterms: () => ["Solid", "WebGL"],
      },
      noopCallbacks(),
    );
    expect(up.apiKey).toBe("k");
    const url = new URL(up.url ?? "");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model_id: "scribe_v2_realtime_ja",
      audio_format: "pcm_24000",
      include_timestamps: "true",
      no_verbatim: "true",
      language_code: "ja",
    });
    // `commit_strategy` is NOT a Scribe parameter — it never appeared in the
    // session_started echo, and sending it bought nothing but a false premise.
    expect(url.searchParams.has("commit_strategy")).toBe(false);
    // keyterms is repeatable — one query param per term.
    expect(url.searchParams.getAll("keyterms")).toEqual(["Solid", "WebGL"]);
  });

  it("emits keyterms as repeated PLAIN params, never the silently-ignored bracket form", () => {
    const up = fakeUpstream();
    openElevenLabsRealtimeSession(
      { apiKey: "k", socketFactory: up.factory, keyterms: () => ["aiui", "contours"] },
      noopCallbacks(),
    );
    // Measured: `keyterms=a&keyterms=b` is parsed; `keyterms[]=…` echoes an empty
    // list. Pin the raw wire form so a regression to the bracket syntax fails here.
    const raw = up.url ?? "";
    expect(raw).toContain("keyterms=aiui");
    expect(raw).toContain("keyterms=contours");
    expect(raw).not.toContain("keyterms%5B%5D"); // URL-encoded `keyterms[]`
    expect(raw).not.toContain("keyterms[]");
  });

  it("defaults the model and omits language/keyterms when unset", () => {
    const up = fakeUpstream();
    openElevenLabsRealtimeSession({ apiKey: "k", socketFactory: up.factory }, noopCallbacks());
    const url = new URL(up.url ?? "");
    expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(url.searchParams.has("language_code")).toBe(false);
    expect(url.searchParams.has("keyterms")).toBe(false);
  });

  it("omits no_verbatim when disabled (leaves the vendor verbatim default)", () => {
    const up = fakeUpstream();
    openElevenLabsRealtimeSession(
      { apiKey: "k", socketFactory: up.factory, noVerbatim: false },
      noopCallbacks(),
    );
    expect(new URL(up.url ?? "").searchParams.has("no_verbatim")).toBe(false);
  });

  it("sends nothing on open, then flushes queued audio in order on session_started", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open(); // Scribe has no setup frame — nothing goes out
    expect(up.sent).toHaveLength(0);
    session.appendAudio(1, new Uint8Array([1, 2]));
    session.appendAudio(1, new Uint8Array([3, 4]));
    expect(up.sent).toHaveLength(0); // still queued — not ready
    up.emit({ message_type: "session_started" });
    expect(up.sent).toHaveLength(2);
    expect(up.sent[0]).toMatchObject({
      message_type: "input_audio_chunk",
      commit: false,
      sample_rate: 24000,
    });
    expect(Buffer.from(up.sent[0].audio_base_64 as string, "base64")).toEqual(Buffer.from([1, 2]));
    expect(Buffer.from(up.sent[1].audio_base_64 as string, "base64")).toEqual(Buffer.from([3, 4]));
  });

  it("echoes cumulative partials to onDelta for the streaming segment", () => {
    const up = fakeUpstream();
    const { session, deltas } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    session.appendAudio(1, new Uint8Array([1]));
    // partial_transcript is CUMULATIVE for the uncommitted utterance — forwarded
    // as-is (no accumulation, unlike OpenAI's incremental deltas).
    up.emit({ message_type: "partial_transcript", text: "make " });
    up.emit({ message_type: "partial_transcript", text: "make the plot" });
    expect(deltas).toEqual([
      { segment: 1, text: "make " },
      { segment: 1, text: "make the plot" },
    ]);
  });

  it("commits with a commit:true empty chunk once past the audio floor", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    session.appendAudio(1, FLOOR_AUDIO); // ≥ floor, so the commit is allowed to flush
    session.commit(1);
    const commits = up.sent.filter((m) => m.commit === true);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      message_type: "input_audio_chunk",
      commit: true,
      audio_base_64: "",
      sample_rate: 24000,
    });
  });

  it("refuses a commit under the floor: no wire commit, an empty final instead", () => {
    const up = fakeUpstream();
    const { session, finals } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    // 200ms — under the 300ms hard minimum; committing it would be FATAL
    // (commit_throttled closes the socket), so the session must not send a commit.
    session.appendAudio(1, audioMs(200));
    session.commit(1);
    expect(up.sent.some((m) => m.commit === true)).toBe(false);
    // The segment still resolves so the caller's preview settles — an empty final.
    expect(finals).toEqual([{ segment: 1, text: "", latencyMs: 0, model: "scribe_v2_realtime" }]);
  });

  it("finalizes on the timestamped completion: words→ms, spacing dropped, logprob carried", () => {
    let clock = 0;
    const up = fakeUpstream();
    const { session, finals } = collect(up, () => clock);
    up.open();
    up.emit({ message_type: "session_started" });
    session.appendAudio(1, FLOOR_AUDIO);
    clock = 1000;
    session.commit(1); // committed at t=1000
    clock = 1600;
    up.emit(
      withTimestamps("make it wider", [
        { text: "make", start: 0.0, end: 0.4, type: "word", logprob: -0.1 },
        { text: " ", start: 0.4, end: 0.42, type: "spacing" },
        { text: "it", start: 0.42, end: 0.6, type: "word", logprob: -0.25 },
        { text: " ", start: 0.6, end: 0.62, type: "spacing" },
        { text: "wider", start: 0.62, end: 1.05, type: "word" },
      ]),
    );
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      segment: 1,
      text: "make it wider",
      latencyMs: 600, // commit → final
      model: "scribe_v2_realtime",
    });
    // Segment 1's audio base is 0, so its timings pass through unshifted.
    expect(finals[0].words).toEqual([
      { text: "make", startMs: 0, endMs: 400, logprob: -0.1 },
      { text: "it", startMs: 420, endMs: 600, logprob: -0.25 },
      { text: "wider", startMs: 620, endMs: 1050 },
    ]);
    // ElevenLabs pricing isn't in our catalog — cost is deliberately omitted.
    expect(finals[0].cost).toBeUndefined();
  });

  it("rebases cumulative word timestamps to each segment's own audio start", () => {
    const up = fakeUpstream();
    const { session, finals } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });

    // Segment 1: 500ms of audio, base 0. Its words sit at 0.1–0.4s.
    session.appendAudio(1, FLOOR_AUDIO);
    session.commit(1);
    up.emit(withTimestamps("one", [{ text: "one", start: 0.1, end: 0.4, type: "word" }]));

    // Segment 2 begins after 500ms of streamed audio → base = 500ms. Scribe reports
    // its words on the CUMULATIVE timeline (start ~10.16s, not 0 — the measured
    // sentence-2 behavior); the session subtracts the 500ms base to make them
    // segment-relative, clamping a word that precedes the base at 0.
    session.appendAudio(2, FLOOR_AUDIO);
    session.commit(2);
    up.emit(
      withTimestamps("two three", [
        { text: "leftover", start: 0.3, end: 0.49, type: "word" }, // before base → clamps to 0
        { text: "two", start: 10.159, end: 10.4, type: "word", logprob: -0.2 },
        { text: " ", start: 10.4, end: 10.42, type: "spacing" },
        { text: "three", start: 10.42, end: 10.9, type: "word" },
      ]),
    );

    expect(finals[0].words).toEqual([{ text: "one", startMs: 100, endMs: 400 }]);
    expect(finals[1].words).toEqual([
      { text: "leftover", startMs: 0, endMs: 0 }, // round(300−500), round(490−500) → clamp 0
      { text: "two", startMs: 9659, endMs: 9900, logprob: -0.2 }, // 10159−500, 10400−500
      { text: "three", startMs: 9920, endMs: 10400 },
    ]);
  });

  it("ignores the plain committed_transcript; the timestamped twin fires the single final", () => {
    const up = fakeUpstream();
    const { session, finals } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    session.appendAudio(1, FLOOR_AUDIO);
    session.commit(1);
    up.emit({ message_type: "committed_transcript", text: "hello world" });
    expect(finals).toEqual([]); // the plain view is ignored while timestamps are on
    up.emit(withTimestamps("hello world"));
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("hello world");
  });

  it("resolves two overlapping commits to their finals in FIFO order (no item ids)", () => {
    const up = fakeUpstream();
    const { session, finals } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    session.appendAudio(1, FLOOR_AUDIO);
    session.commit(1);
    session.appendAudio(2, FLOOR_AUDIO);
    session.commit(2);
    up.emit(withTimestamps("first"));
    up.emit(withTimestamps("second"));
    expect(finals.map((f) => ({ segment: f.segment, text: f.text }))).toEqual([
      { segment: 1, text: "first" },
      { segment: 2, text: "second" },
    ]);
  });

  it("discard sends nothing on the wire and stops a stale partial leaking", () => {
    const up = fakeUpstream();
    const { session, deltas, finals, errors } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    session.appendAudio(1, audioMs(50));
    up.emit({ message_type: "partial_transcript", text: "hm" });
    expect(deltas).toEqual([{ segment: 1, text: "hm" }]);

    session.discard(1);
    // No wire message: committing sub-0.3s audio is FATAL (commit_throttled closes
    // the socket) and there is no buffer-clear — so discard is purely local.
    expect(up.sent.some((m) => m.commit === true)).toBe(false);
    // A late partial for the discarded utterance no longer leaks to onDelta.
    up.emit({ message_type: "partial_transcript", text: "hmm" });
    expect(deltas).toHaveLength(1);
    expect(finals).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("discard keeps the stray audio in the buffer — it counts toward the next commit's floor", () => {
    const up = fakeUpstream();
    const { session, finals } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    // Segment 1: 300ms, then discarded (no commit, audio stays in the buffer).
    session.appendAudio(1, audioMs(300));
    session.discard(1);
    // Segment 2 adds only 250ms — under the 500ms floor ON ITS OWN, but the 300ms
    // of leftover-in-buffer audio pushes the total over, so segment 2 DOES commit.
    session.appendAudio(2, audioMs(250));
    session.commit(2);
    expect(up.sent.some((m) => m.commit === true)).toBe(true);
    up.emit(withTimestamps("kept"));
    expect(finals.map((f) => ({ segment: f.segment, text: f.text }))).toEqual([
      { segment: 2, text: "kept" },
    ]);
  });

  it("drain resolves once the committed segment finalizes", async () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    session.appendAudio(1, FLOOR_AUDIO);
    session.commit(1);
    const drained = session.drain(1000);
    up.emit(withTimestamps("done"));
    await expect(drained).resolves.toEqual([]);
  });

  it("drain times out with the still-pending segments", async () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    session.appendAudio(3, FLOOR_AUDIO);
    session.commit(3);
    await expect(session.drain(20)).resolves.toEqual([3]);
  });

  it("drain ignores a discarded segment (discard never enters the FIFO queue)", async () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    session.appendAudio(1, FLOOR_AUDIO);
    session.discard(1); // enqueues nothing — the queue stays empty
    await expect(session.drain(1000)).resolves.toEqual([]);
  });

  it("routes an error to the oldest in-flight committed segment (FIFO head)", () => {
    const up = fakeUpstream();
    const { session, finals, errors } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    session.appendAudio(1, FLOOR_AUDIO);
    session.commit(1);
    session.appendAudio(2, FLOOR_AUDIO);
    session.commit(2);
    up.emit({ message_type: "transcriber_error", error: "decoder blew up" });
    // The head (segment 1) is finalized loudly; segment 2 stays in flight.
    expect(errors).toEqual([{ message: "decoder blew up", segment: 1 }]);
    // The error removed segment 1, so the next completion resolves segment 2 —
    // no double-finalize of the errored head.
    up.emit(withTimestamps("second"));
    expect(finals.map((f) => ({ segment: f.segment, text: f.text }))).toEqual([
      { segment: 2, text: "second" },
    ]);
  });

  it("surfaces an error session-wide when nothing is in flight", () => {
    const up = fakeUpstream();
    const { errors } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    up.emit({ message_type: "auth_error", error: "invalid xi-api-key" });
    expect(errors).toEqual([{ message: "invalid xi-api-key" }]);
  });

  it("a transport error finalizes every outstanding segment loudly", () => {
    const up = fakeUpstream();
    const { session, errors } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    session.appendAudio(1, FLOOR_AUDIO);
    session.commit(1);
    session.appendAudio(2, FLOOR_AUDIO);
    session.commit(2);
    up.error("connection reset");
    expect(errors).toEqual([
      { message: "connection reset", segment: 1 },
      { message: "connection reset", segment: 2 },
    ]);
    // Once dead, a later commit fails immediately rather than hanging.
    session.commit(3);
    expect(errors.at(-1)).toEqual({ message: "realtime session unavailable", segment: 3 });
  });

  it("a mid-flight close finalizes outstanding segments with the close reason", () => {
    const up = fakeUpstream();
    const { session, errors } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    session.appendAudio(1, FLOOR_AUDIO);
    session.commit(1);
    // A commit_throttled teardown arrives as a close with reason — surfaced verbatim.
    up.serverClose(1000, "commit_throttled");
    expect(errors).toEqual([
      { message: "realtime session closed (1000: commit_throttled)", segment: 1 },
    ]);
  });

  it("close() closes the socket, releases a pending drain, and is idempotent", async () => {
    const up = fakeUpstream();
    const { session, errors, finals } = collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    session.appendAudio(1, FLOOR_AUDIO);
    session.commit(1);
    const drained = session.drain(10_000);
    session.close();
    expect(up.closed).toBe(true);
    await expect(drained).resolves.toEqual([1]);
    // A second close neither throws nor re-fires callbacks (already dead).
    session.close();
    expect(errors).toEqual([]);
    expect(finals).toEqual([]);
  });

  it("ignores a malformed upstream frame instead of throwing", () => {
    const up = fakeUpstream();
    collect(up);
    up.open();
    up.emit({ message_type: "session_started" });
    expect(() => up.raw("not json")).not.toThrow();
  });
});

// ── the idle keepalive (the ~15s server timeout) ─────────────────────────────

describe("idle keepalive", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // A keepalive is the empty ({audio_base_64:"", commit:false}) heartbeat chunk.
  const keepalives = (up: FakeUpstream) =>
    up.sent.filter(
      (m) => m.message_type === "input_audio_chunk" && m.commit === false && m.audio_base_64 === "",
    );

  it("sends an empty chunk after each idle interval, and stops on close", () => {
    const up = fakeUpstream();
    const session = openElevenLabsRealtimeSession(
      { apiKey: "k", socketFactory: up.factory },
      noopCallbacks(),
    );
    up.open();
    up.emit({ message_type: "session_started" });
    expect(keepalives(up)).toHaveLength(0);
    // The heartbeat resets the server's ~15s idle timeout (measured) without
    // touching the buffer or the cumulative timestamp timeline — an empty chunk.
    vi.advanceTimersByTime(ELEVENLABS_KEEPALIVE_MS);
    expect(keepalives(up)).toHaveLength(1);
    vi.advanceTimersByTime(ELEVENLABS_KEEPALIVE_MS);
    expect(keepalives(up)).toHaveLength(2);
    session.close();
    vi.advanceTimersByTime(ELEVENLABS_KEEPALIVE_MS * 3);
    expect(keepalives(up)).toHaveLength(2); // cleared on close — no more heartbeats
  });

  it("a real frame resets the idle timer (no keepalive while audio flows)", () => {
    const up = fakeUpstream();
    const session = openElevenLabsRealtimeSession(
      { apiKey: "k", socketFactory: up.factory },
      noopCallbacks(),
    );
    up.open();
    up.emit({ message_type: "session_started" });
    vi.advanceTimersByTime(ELEVENLABS_KEEPALIVE_MS - 1);
    session.appendAudio(1, new Uint8Array(48)); // a real frame re-arms the heartbeat
    vi.advanceTimersByTime(ELEVENLABS_KEEPALIVE_MS - 1);
    expect(keepalives(up)).toHaveLength(0); // the append pushed it out
    vi.advanceTimersByTime(2);
    expect(keepalives(up)).toHaveLength(1); // fires only after true idle
  });
});

// ── the pure helpers ─────────────────────────────────────────────────────────

describe("convertWords", () => {
  it("drops spacing, rounds seconds→ms, carries logprob, tolerates junk entries", () => {
    expect(
      convertWords([
        { text: "a", start: 0.001, end: 0.4004, type: "word", logprob: -0.5 },
        { text: " ", start: 0.4, end: 0.42, type: "spacing" },
        "junk",
        null,
        { text: "b", type: "word" }, // no timings — text alone
      ]),
    ).toEqual([{ text: "a", startMs: 1, endMs: 400, logprob: -0.5 }, { text: "b" }]);
    expect(convertWords(undefined)).toEqual([]);
    expect(convertWords("nope")).toEqual([]);
  });

  it("rebases by baseMs and clamps pre-base timings at 0", () => {
    expect(
      convertWords(
        [
          { text: "early", start: 9.9, end: 10.05, type: "word" }, // start precedes the base
          { text: "late", start: 10.5, end: 10.9, type: "word" },
        ],
        10_000, // 10s segment base on the cumulative timeline
      ),
    ).toEqual([
      { text: "early", startMs: 0, endMs: 50 }, // round(9900−10000)→clamp 0; round(10050−10000)=50
      { text: "late", startMs: 500, endMs: 900 },
    ]);
  });
});

describe("isErrorType", () => {
  it("matches the known set and any unknown *error type, not the transcript types", () => {
    expect(isErrorType("insufficient_audio_activity")).toBe(true);
    expect(isErrorType("commit_throttled")).toBe(true);
    expect(isErrorType("auth_error")).toBe(true);
    expect(isErrorType("some_future_error")).toBe(true); // unknown, but *error
    expect(isErrorType("partial_transcript")).toBe(false);
    expect(isErrorType("session_started")).toBe(false);
    expect(isErrorType("committed_transcript_with_timestamps")).toBe(false);
  });
});

// ── Scribe self-commits: a segment is many utterances ────────────────────────
//
// The bug that motivated all of this. Scribe caps an utterance (~40 s, live-
// verified) and closes it WITHOUT being asked, then resets its partial to empty.
// These frames used to hit `completeHead` with an empty FIFO and be discarded as
// "stray", destroying the transcript. Regression-lock the accumulation.

describe("vendor-initiated commits (Scribe closes utterances by itself)", () => {
  function session(up: FakeUpstream, now: () => number = () => 0) {
    const deltas: Array<{ segment: number; text: string }> = [];
    const finals: Array<{ segment: number } & RealtimeResult> = [];
    const diagnostics: RealtimeDiagnostic[] = [];
    const s = openElevenLabsRealtimeSession(
      { apiKey: "k", socketFactory: up.factory, now },
      {
        onDelta: (segment, text) => deltas.push({ segment, text }),
        onFinal: (segment, result) => finals.push({ segment, ...result }),
        onError: () => {},
        onDiagnostic: (e) => diagnostics.push(e),
      },
    );
    return { s, deltas, finals, diagnostics };
  }

  /** Enough audio to clear the commit floor. */
  const audio = (s: ReturnType<typeof session>["s"], segment: number) =>
    s.appendAudio(segment, new Uint8Array(ELEVENLABS_COMMIT_FLOOR_MS * 48 * 2));

  it("accumulates a self-committed utterance into the segment's final", () => {
    const up = fakeUpstream();
    const { s, finals, diagnostics } = session(up);
    up.open();
    up.emit({ message_type: "session_started" });
    audio(s, 1);

    // Scribe closes utterance one on its own — nothing of ours is in flight.
    up.emit(withTimestamps("the first part.", [{ text: "first", start: 1, end: 2, type: "word" }]));
    expect(finals).toHaveLength(0); // not a final: the segment is still streaming
    expect(diagnostics).toContainEqual({
      kind: "vendor-commit",
      segment: 1,
      chars: "the first part.".length,
      words: 1,
    });

    // The user releases; our commit's answer carries only the tail.
    audio(s, 1);
    s.commit(1);
    up.emit(withTimestamps("the tail.", [{ text: "tail", start: 3, end: 4, type: "word" }]));

    expect(finals).toHaveLength(1);
    expect(finals[0].segment).toBe(1);
    expect(finals[0].text).toBe("the first part. the tail.");
    expect(finals[0].words?.map((w) => w.text)).toEqual(["first", "tail"]);
  });

  it("keeps onDelta cumulative across Scribe's partial reset", () => {
    const up = fakeUpstream();
    const { s, deltas } = session(up);
    up.open();
    up.emit({ message_type: "session_started" });
    audio(s, 1);

    up.emit({ message_type: "partial_transcript", text: "hello there" });
    expect(deltas.at(-1)).toEqual({ segment: 1, text: "hello there" });

    // Self-commit → the accumulated text is re-emitted, so the preview never shrinks.
    up.emit(withTimestamps("hello there."));
    expect(deltas.at(-1)).toEqual({ segment: 1, text: "hello there." });

    // Scribe's next partial starts from empty; we prefix what it already closed.
    up.emit({ message_type: "partial_transcript", text: "and more" });
    expect(deltas.at(-1)).toEqual({ segment: 1, text: "hello there. and more" });
  });

  it("a long segment whose tail is silence still finalizes with the vendor's text", () => {
    // The exact production failure: 134 s held, Scribe self-committed, the tail
    // was silence, and the final came back EMPTY.
    const up = fakeUpstream();
    const { s, finals } = session(up);
    up.open();
    up.emit({ message_type: "session_started" });
    audio(s, 1);
    up.emit(withTimestamps("everything the user said."));
    audio(s, 1);
    s.commit(1);
    up.emit({ message_type: "committed_transcript_with_timestamps", text: "", words: [] });

    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("everything the user said.");
  });

  it("carries vendor-committed text through a sub-floor commit (no wire commit)", () => {
    const up = fakeUpstream();
    const { s, finals } = session(up);
    up.open();
    up.emit({ message_type: "session_started" });
    audio(s, 1);
    up.emit(withTimestamps("said before the scrap."));
    s.appendAudio(1, new Uint8Array(10)); // a scrap, under the floor
    const before = up.sent.length;
    s.commit(1);
    // Nothing on the wire (committing under the floor is fatal) …
    expect(up.sent.filter((m) => m.commit === true)).toHaveLength(0);
    expect(up.sent.length).toBe(before);
    // … but the segment still owns what Scribe already committed inside it.
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("said before the scrap.");
  });

  it("drops a discarded segment's accumulated text", () => {
    const up = fakeUpstream();
    const { s, finals } = session(up);
    up.open();
    up.emit({ message_type: "session_started" });
    audio(s, 1);
    up.emit(withTimestamps("abandoned words."));
    s.discard(1);
    audio(s, 2);
    s.commit(2);
    up.emit(withTimestamps("segment two."));
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ segment: 2, text: "segment two." });
  });

  it("reports a truly orphaned completion instead of swallowing it", () => {
    const up = fakeUpstream();
    const { s, finals, diagnostics } = session(up);
    up.open();
    up.emit({ message_type: "session_started" });
    s.discard(1); // nothing streaming, nothing committed
    up.emit(withTimestamps("nobody's text."));
    expect(finals).toHaveLength(0);
    expect(diagnostics).toContainEqual({
      kind: "orphan-result",
      messageType: "committed_transcript_with_timestamps",
      chars: "nobody's text.".length,
    });
  });

  it("reports an unknown message type rather than returning silently", () => {
    const up = fakeUpstream();
    const { diagnostics } = session(up);
    up.open();
    up.emit({ message_type: "utterance_boundary_v3", detail: "who knows" });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ kind: "unhandled", messageType: "utterance_boundary_v3" }),
    );
  });
});

// ── the config echo: the only proof a query param exists ─────────────────────

describe("checkConfigEcho", () => {
  it("passes when the echo confirms what we asked for (string/bool coercion)", () => {
    expect(
      checkConfigEcho(
        { model_id: "scribe_v2_realtime", include_timestamps: true, no_verbatim: true },
        { model_id: "scribe_v2_realtime", include_timestamps: true, no_verbatim: true },
      ),
    ).toEqual([]);
  });

  it("flags a param the vendor never confirmed — the commit_strategy class of bug", () => {
    expect(checkConfigEcho({ no_verbatim: true }, { model_id: "x" })).toEqual([
      { param: "no_verbatim", requested: true, echoed: "(absent)" },
    ]);
  });

  it("flags a param the vendor silently overrode", () => {
    expect(checkConfigEcho({ include_timestamps: true }, { include_timestamps: false })).toEqual([
      { param: "include_timestamps", requested: true, echoed: false },
    ]);
  });

  it("says nothing when there is no echo to check", () => {
    expect(checkConfigEcho({ no_verbatim: true }, undefined)).toEqual([]);
  });
});

describe("the connect URL no longer carries a parameter that does not exist", () => {
  it("omits commit_strategy (absent from the session_started echo; never took effect)", () => {
    const up = fakeUpstream();
    openElevenLabsRealtimeSession({ apiKey: "k", socketFactory: up.factory }, {
      onDelta: () => {},
      onFinal: () => {},
      onError: () => {},
    } satisfies RealtimeCallbacks);
    expect(up.url).not.toContain("commit_strategy");
  });

  it("surfaces the echo, and a mismatch within it, as diagnostics", () => {
    const up = fakeUpstream();
    const diagnostics: RealtimeDiagnostic[] = [];
    openElevenLabsRealtimeSession(
      { apiKey: "k", socketFactory: up.factory },
      {
        onDelta: () => {},
        onFinal: () => {},
        onError: () => {},
        onDiagnostic: (e) => diagnostics.push(e),
      },
    );
    up.open();
    up.emit({
      message_type: "session_started",
      config: { model_id: "scribe_v2_realtime", include_timestamps: true, no_verbatim: false },
    });
    expect(diagnostics[0]).toMatchObject({ kind: "config-echo" });
    expect(diagnostics).toContainEqual({
      kind: "config-mismatch",
      param: "no_verbatim",
      requested: true,
      echoed: false,
    });
  });
});
