/**
 * The ORACLE sidecar, driven through the unified intent processor — the
 * capture-bus Phase 2 contracts:
 *
 *  - the route switch: while the oracle holds the mic, audio goes to it ALONE
 *    (not the STT session, not a linter), and talk segments resolve EMPTY
 *    (prompt building paused — never a "transcription failed");
 *  - the journeys' XOR: a hello carrying both coerces (oracle wins); the
 *    mid-thread controls enforce it in both directions;
 *  - the §8-6 record: `oracle-heard` / `oracle-said` events (never prompt
 *    text — the compiler ignores them);
 *  - `read_file` round-trips through `oracle-tool-call`/`-result`;
 *  - keyless oracling degrades LOUDLY while briefing capture keeps working.
 *
 * The engine is a scripted {@link LiveSession} (options.oracleSessionFactory)
 * — the OpenAI dialect (server_vad, input transcription) has its own suite
 * in openai-live.test.ts.
 */
import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelFormat, MessageMeta, StreamProcessor, ThreadContext } from "./channel";
import type { ChunkDescriptor } from "./frame";
import { createIntentV1Format, type IntentV1Options } from "./intent-v1";
import type { LiveSession, LiveSessionCallbacks } from "./live-session";

const enc = new TextEncoder();

// The keyless posture (see intent-v1.linter.test.ts for why the env vars are
// DELETED, not blanked): option absent → env lookup → nothing → degrade loudly.
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("GEMINI_API_KEY", undefined);
  vi.stubEnv("ELEVEN_LABS_API_KEY", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

interface FakeLive {
  factory: (callbacks: LiveSessionCallbacks) => LiveSession;
  calls: Array<{ op: string; arg?: unknown }>;
  callbacks(): LiveSessionCallbacks;
}

function fakeLive(): FakeLive {
  let cbs: LiveSessionCallbacks | undefined;
  const fake: FakeLive = {
    calls: [],
    factory: (callbacks) => {
      cbs = callbacks;
      return {
        capabilities: { video: true, imageInjection: "turn-item" },
        activityStart: () => fake.calls.push({ op: "activityStart" }),
        appendAudio: (pcm) => fake.calls.push({ op: "appendAudio", arg: pcm.length }),
        activityEnd: () => fake.calls.push({ op: "activityEnd" }),
        injectLabeledImage: (label) => fake.calls.push({ op: "injectLabeledImage", arg: label }),
        injectContextText: (text) => fake.calls.push({ op: "injectContextText", arg: text }),
        cancelActiveResponse: () => fake.calls.push({ op: "cancel" }),
        close: () => fake.calls.push({ op: "close" }),
      };
    },
    callbacks: () => {
      if (!cbs) {
        throw new Error("the oracle never opened its session");
      }
      return cbs;
    },
  };
  return fake;
}

interface Driver {
  feedEvents(events: IntentEvent[], fin?: boolean): Promise<void>;
  feedAudio(segment: number, seq: number, bytes: Uint8Array): Promise<void>;
  feedControl(control: string, value: string): Promise<void>;
  close(): void;
  sent: Array<{ text: string }>;
  pushed: unknown[];
}

function drive(intent: Record<string, unknown>, options: IntentV1Options = {}): Driver {
  const sent: Array<{ text: string }> = [];
  const pushed: unknown[] = [];
  const ctx: ThreadContext = {
    threadId: "t-oracle",
    hello: { intent },
    sendPrompt: (text) => {
      sent.push({ text });
    },
    push: (message) => {
      pushed.push(message);
    },
    close: () => {},
  };
  const format: ChannelFormat = createIntentV1Format(options);
  const processor: StreamProcessor = format.createProcessor(ctx);
  const send = (payload: Uint8Array, chunk: ChunkDescriptor | undefined, fin: boolean) =>
    Promise.resolve(
      processor.onMessage(payload, {
        fin,
        ...(chunk !== undefined ? { chunk } : {}),
      } as MessageMeta),
    );
  return {
    feedEvents: (events, fin = false) =>
      Promise.resolve(send(enc.encode(JSON.stringify({ events })), { kind: "events" }, fin)),
    feedAudio: (segment, seq, bytes) =>
      Promise.resolve(
        send(bytes, { kind: "audio", id: `seg_${segment}`, seq, mime: "audio/pcm" }, false),
      ),
    feedControl: (control, value) =>
      Promise.resolve(
        send(enc.encode(JSON.stringify({ control, value })), { kind: "control" }, false),
      ),
    close: () => processor.onClose?.(),
    sent,
    pushed,
  };
}

const opening = (): IntentEvent[] => [
  { at: 1, type: "armed", on: true },
  { at: 2, type: "thread-open", trigger: "talk" },
];

const ORACLE_HELLO = { transcriber: "mock", oracle: "openai" };

const eventsOf = (pushed: unknown[], type: string): IntentEvent[] =>
  pushed.flatMap((m) =>
    (((m as { events?: IntentEvent[] }).events ?? []) as IntentEvent[]).filter(
      (e) => e.type === type,
    ),
  );

describe("the route switch — the oracle holds the mic", () => {
  it("audio frames go to the oracle ALONE, and talk segments resolve EMPTY (prompt paused)", async () => {
    const live = fakeLive();
    const d = drive(ORACLE_HELLO, { oracleSessionFactory: live.factory });
    await d.feedEvents([...opening(), { at: 10, type: "talk-start", segment: 1 }]);
    await d.feedAudio(1, 0, new Uint8Array(9600)); // 200 ms of PCM24k
    expect(live.calls.filter((c) => c.op === "appendAudio")).toHaveLength(1);

    await d.feedEvents([{ at: 20, type: "talk-end", segment: 1, ms: 400 }]);
    // The segment resolved EMPTY — the preview stops waiting, nothing composes.
    const finals = eventsOf(d.pushed, "transcript-final") as Array<{ text: string; model: string }>;
    expect(finals).toEqual([expect.objectContaining({ text: "", model: "oracle" })]);
  });

  it("barge-in is the VENDOR's, not ours: talk-start sends no cancel; onInterrupted stops playback", async () => {
    const live = fakeLive();
    const d = drive(ORACLE_HELLO, { oracleSessionFactory: live.factory });
    await d.feedEvents([...opening(), { at: 10, type: "talk-start", segment: 1 }]);
    // Server VAD owns turn-taking AND barge-in — we never second-guess it.
    expect(live.calls.filter((c) => c.op === "cancel")).toHaveLength(0);

    // A reply is streaming (chunks forward the moment they arrive)…
    live.callbacks().onReplyAudio(new Uint8Array([1, 2]), "audio/pcm;rate=24000");
    const chunks = d.pushed.filter(
      (m) => (m as { kind?: string; seq?: number }).kind === "speech",
    ) as Array<{ id: string; seq: number }>;
    expect(chunks).toEqual([expect.objectContaining({ id: "oracle_0", seq: 0 })]);

    // …the vendor hears the human resume and interrupts ITSELF; we listen
    // (input_audio_buffer.speech_started → onInterrupted) and relay the stop.
    live.callbacks().onInterrupted();
    expect(
      d.pushed.some(
        (m) =>
          (m as { kind?: string; id?: string }).kind === "speech-cancel" &&
          (m as { id?: string }).id === "oracle_0",
      ),
    ).toBe(true);
  });

  it("shots and selections forward to the oracle like they did to the linter", async () => {
    const live = fakeLive();
    const d = drive(ORACLE_HELLO, { oracleSessionFactory: live.factory });
    await d.feedEvents([
      ...opening(),
      { at: 10, type: "app-selection", marker: "sel_1", text: "gradient stops" },
    ]);
    const labels = live.calls.filter((c) => c.op === "injectContextText").map((c) => String(c.arg));
    expect(labels[0]).toContain('[selection sel_1: "gradient stops"');
  });
});

describe("the §8-6 record — oracle-heard / oracle-said", () => {
  it("input + reply transcripts push as record events (and never as prompt text)", async () => {
    const live = fakeLive();
    const d = drive(ORACLE_HELLO, { oracleSessionFactory: live.factory });
    await d.feedEvents(opening());
    live.callbacks().onInputTranscript?.("what does the fold do");
    live.callbacks().onReplyTranscript("it folds events into items");
    expect(eventsOf(d.pushed, "oracle-heard")).toEqual([
      expect.objectContaining({ text: "what does the fold do" }),
    ]);
    expect(eventsOf(d.pushed, "oracle-said")).toEqual([
      expect.objectContaining({ text: "it folds events into items" }),
    ]);
  });

  it("read_file round-trips through oracle-tool-call / oracle-tool-result", async () => {
    const live = fakeLive();
    const d = drive(ORACLE_HELLO, { oracleSessionFactory: live.factory });
    await d.feedEvents(opening());
    let answered: string | undefined;
    live.callbacks().onToolCall?.({
      tool: "read_file",
      args: { path: "/nonexistent/aiui-oracle-test.txt" },
      respond: (result) => {
        answered = result;
      },
    });
    expect(eventsOf(d.pushed, "oracle-tool-call")).toHaveLength(1);
    const results = eventsOf(d.pushed, "oracle-tool-result") as Array<{ ok: boolean }>;
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false); // ENOENT — returned to the model, never thrown
    expect(answered).toContain("ENOENT");
  });
});

describe("the journeys' XOR — oracle ⊕ linter", () => {
  it("a hello carrying BOTH coerces: the oracle wins, the linter never opens", async () => {
    const oracleLive = fakeLive();
    const linterLive = fakeLive();
    const d = drive(
      { transcriber: "mock", oracle: "openai", linter: "openai" },
      { oracleSessionFactory: oracleLive.factory, linterSessionFactory: linterLive.factory },
    );
    await d.feedEvents([...opening(), { at: 10, type: "talk-start", segment: 1 }]);
    await d.feedAudio(1, 0, new Uint8Array(4800));
    expect(oracleLive.calls.some((c) => c.op === "appendAudio")).toBe(true);
    expect(() => linterLive.callbacks()).toThrow(); // never opened
  });

  it("a mid-thread oracle-on closes a running linter; a linter-on closes a running oracle", async () => {
    const oracleLive = fakeLive();
    const linterLive = fakeLive();
    const d = drive(
      { transcriber: "mock", linter: "openai" },
      { oracleSessionFactory: oracleLive.factory, linterSessionFactory: linterLive.factory },
    );
    await d.feedEvents(opening());
    linterLive.callbacks(); // the linter opened from the hello

    await d.feedControl("oracle", "openai");
    expect(linterLive.calls.some((c) => c.op === "close")).toBe(true); // XOR: linter closed
    oracleLive.callbacks(); // the oracle opened

    await d.feedControl("linter", "openai");
    expect(oracleLive.calls.some((c) => c.op === "close")).toBe(true); // XOR: oracle closed
  });
});

describe("posture", () => {
  it("keyless oracling degrades loudly — and briefing capture still works", async () => {
    const d = drive(ORACLE_HELLO); // no key, no seams: the real keyless path
    await d.feedEvents(opening());
    const notes = eventsOf(d.pushed, "note") as Array<{ text: string }>;
    expect(notes.some((n) => n.text.includes("oracle disabled"))).toBe(true);
    // The turn machinery is unharmed: talk still opens/commits (mock path).
    await d.feedEvents([{ at: 10, type: "talk-start", segment: 1 }]);
  });

  it("fin/teardown closes the oracle session", async () => {
    const live = fakeLive();
    const d = drive(ORACLE_HELLO, { oracleSessionFactory: live.factory });
    await d.feedEvents(opening());
    d.close();
    expect(live.calls.some((c) => c.op === "close")).toBe(true);
  });
});
