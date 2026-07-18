/**
 * The prompt-linter sidecar, driven through the UNIFIED intent processor —
 * the wire-order contracts the linter pivot rests on:
 *
 *  - the `[transcript seg_N: …]` item precedes `activityEnd` (the lint judges
 *    the compiler's transcription, not just its own hearing);
 *  - the transcript wait times out rather than wedging the lint;
 *  - resumed talk MERGES into the open window (no turn boundary);
 *  - lint replies become `linter-note` events (pushed + chronicled) that the
 *    compiler IGNORES (the committed prompt is unchanged by them);
 *  - `read_file` round-trips through `linter-tool-call`/`-result` events;
 *  - shots/selections/video forward with their labels;
 *  - keyless linting degrades LOUDLY while dictation keeps working.
 *
 * The engine is a scripted {@link LiveSession} (options.linterSessionFactory)
 * — the vendor dialects have their own suites (openai-live/gemini-live).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelFormat, StreamProcessor, ThreadContext } from "./channel";
import type { ChunkDescriptor, MessageMeta } from "./frame";
import { createIntentV1Format, type IntentV1Options } from "./intent-v1";
import { TRANSCRIPT_WAIT_MS } from "./linter-sidecar";
import type { LiveSession, LiveSessionCallbacks } from "./live-session";
import type { IntentEvent } from "./overlay-types";

const enc = new TextEncoder();

/**
 * Run the whole suite as a channel process that holds NO vendor keys.
 *
 * `createIntentV1Format` resolves each key as `options.<key> ?? process.env.<KEY>`
 * (intent-v1.ts), so a test that passes `geminiApiKey: undefined` to assert the
 * keyless posture silently picks up a *developer's real key* instead — this repo
 * loads one into the shell from `.env.dev` via direnv, so `keyless gemini
 * linting degrades loudly` passed in CI and failed on the machine of anyone set
 * up to run the thing. Deleting the vars (`vi.stubEnv(name, undefined)`, not
 * `""`) keeps the assertions exercising the real production path: option absent
 * → env lookup → nothing → degrade loudly.
 */
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
  /** Every session call, in order — the wire-order assertions read this. */
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
        capabilities: { video: true, imageInjection: "stream" },
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
        throw new Error("the sidecar never opened its session");
      }
      return cbs;
    },
  };
  return fake;
}

interface Driver {
  feedEvents(events: IntentEvent[], fin?: boolean): Promise<void>;
  feedAttachment(id: string, bytes: Uint8Array): Promise<void>;
  /** A mid-thread `control` chunk (the client's linter select moving). */
  feedControl(control: string, value: string): Promise<void>;
  fin(): Promise<void>;
  close(): void;
  sent: Array<{ text: string }>;
  pushed: unknown[];
}

function drive(intent: Record<string, unknown>, options: IntentV1Options = {}): Driver {
  const sent: Array<{ text: string }> = [];
  const pushed: unknown[] = [];
  const ctx: ThreadContext = {
    threadId: "t-lint",
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
    processor.onMessage(payload, { fin, ...(chunk !== undefined ? { chunk } : {}) } as MessageMeta);
  return {
    feedEvents: (events, fin = false) =>
      Promise.resolve(send(enc.encode(JSON.stringify({ events })), { kind: "events" }, fin)),
    feedAttachment: (id, bytes) =>
      Promise.resolve(send(bytes, { kind: "attachment", id, mime: "image/png" }, false)),
    feedControl: (control, value) =>
      Promise.resolve(
        send(enc.encode(JSON.stringify({ control, value })), { kind: "control" }, false),
      ),
    fin: () => Promise.resolve(send(new Uint8Array(0), undefined, true)),
    close: () => processor.onClose?.(),
    sent,
    pushed,
  };
}

/** A minimal armed dictation turn's opening (mock transcriber — finals ride the stream). */
const opening = (): IntentEvent[] => [
  { at: 1, type: "armed", on: true },
  { at: 2, type: "thread-open", trigger: "talk" },
];

const talkSegment = (segment: number, text: string): IntentEvent[] => [
  { at: 10 * segment, type: "talk-start", segment },
  { at: 10 * segment + 5, type: "talk-end", segment, ms: 400 },
  {
    at: 10 * segment + 6,
    type: "transcript-final",
    segment,
    text,
    latencyMs: 50,
    model: "mock",
  },
];

const LINT_HELLO = { transcriber: "mock", linter: "openai" };

const eventsOf = (pushed: unknown[], type: string): IntentEvent[] =>
  pushed.flatMap((m) =>
    (((m as { events?: IntentEvent[] }).events ?? []) as IntentEvent[]).filter(
      (e) => e.type === type,
    ),
  );

describe("the turn-end lint sequence (wire order)", () => {
  it("injects [transcript seg_N] BEFORE activityEnd once the final lands", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([...opening(), ...talkSegment(1, "make the plot wider")]);

    const ops = live.calls.map((c) => c.op);
    expect(ops).toEqual(["cancel", "activityStart", "injectContextText", "activityEnd"]);
    expect(live.calls[2].arg).toBe('[transcript seg_1: "make the plot wider"]');
  });

  it("times out the transcript wait rather than wedging; a late final still injects", async () => {
    vi.useFakeTimers();
    try {
      const live = fakeLive();
      const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
      await d.feedEvents([
        ...opening(),
        { at: 10, type: "talk-start", segment: 1 },
        { at: 15, type: "talk-end", segment: 1, ms: 400 },
      ]);
      expect(live.calls.map((c) => c.op)).not.toContain("activityEnd");

      vi.advanceTimersByTime(TRANSCRIPT_WAIT_MS + 1);
      expect(live.calls.at(-1)?.op).toBe("activityEnd"); // ended WITHOUT the transcript

      // The late final still injects (silently) — the next lint sees it.
      await d.feedEvents([
        {
          at: 99,
          type: "transcript-final",
          segment: 1,
          text: "late words",
          latencyMs: 9,
          model: "mock",
        },
      ]);
      expect(live.calls.at(-1)).toEqual({
        op: "injectContextText",
        arg: '[transcript seg_1: "late words"]',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges a resumed talk into the open window — no turn boundary fires", async () => {
    vi.useFakeTimers();
    try {
      const live = fakeLive();
      const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
      await d.feedEvents([
        ...opening(),
        { at: 10, type: "talk-start", segment: 1 },
        { at: 15, type: "talk-end", segment: 1, ms: 400 },
        // …the human resumes before the transcript (or the timeout) lands:
        { at: 16, type: "talk-start", segment: 2 },
      ]);
      vi.advanceTimersByTime(TRANSCRIPT_WAIT_MS + 1);
      const ops = live.calls.map((c) => c.op);
      // ONE window: a single activityStart, and no activityEnd from the
      // merged boundary (the cancelled wait never fires).
      expect(ops.filter((op) => op === "activityStart")).toHaveLength(1);
      expect(ops).not.toContain("activityEnd");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mid-thread linter control (start / stop / swap live, no turn boundary)", () => {
  it("STARTS the linter mid-thread — a control chunk builds the sidecar the hello omitted", async () => {
    const live = fakeLive();
    const d = drive({ transcriber: "mock", linter: "off" }, { linterSessionFactory: live.factory });
    await d.feedEvents([...opening(), ...talkSegment(1, "first utterance")]);
    // linter "off": the session was never opened, so seg 1 lints nothing.
    expect(() => live.callbacks()).toThrow();

    await d.feedControl("linter", "openai");
    await d.feedEvents(talkSegment(2, "second utterance"));
    // Now the sidecar exists and lints the SECOND segment.
    const ops = live.calls.map((c) => c.op);
    expect(ops).toContain("activityStart");
    expect(ops).toContain("activityEnd");
    expect(live.calls.find((c) => c.op === "injectContextText")?.arg).toBe(
      '[transcript seg_2: "second utterance"]',
    );
  });

  it("STOPS the linter mid-thread — a control 'off' closes the sidecar; later talk lints nothing", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([...opening(), ...talkSegment(1, "first")]);
    expect(live.calls.map((c) => c.op)).toContain("activityEnd");

    await d.feedControl("linter", "off");
    expect(live.calls.at(-1)?.op).toBe("close"); // the sidecar closed
    await d.feedEvents(talkSegment(2, "second"));
    expect(live.calls.at(-1)?.op).toBe("close"); // nothing since — no re-lint
  });

  it("SWAPS the linter vendor mid-thread — the old sidecar closes, a fresh one lints on", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory }); // openai
    await d.feedEvents([...opening(), ...talkSegment(1, "first")]);
    const closesBefore = live.calls.filter((c) => c.op === "close").length;

    await d.feedControl("linter", "gemini");
    expect(live.calls.filter((c) => c.op === "close").length).toBe(closesBefore + 1);
    await d.feedEvents(talkSegment(2, "second"));
    expect(live.calls.at(-1)?.op).toBe("activityEnd"); // the fresh sidecar lints seg 2
  });

  it("ignores an unchanged / unrecognized / non-linter control (no churn)", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([...opening(), ...talkSegment(1, "first")]);
    const n = live.calls.length;
    await d.feedControl("linter", "openai"); // unchanged
    await d.feedControl("linter", "banana"); // unrecognized value
    await d.feedControl("other", "thing"); // not the linter control
    expect(live.calls.length).toBe(n); // no close, no reopen
  });
});

describe("lint products (notes, audio, tools)", () => {
  it("a reply transcript becomes a linter-note (pushed + chronicled), and the compiler ignores it", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([...opening(), ...talkSegment(1, "make the plot wider")]);

    live.callbacks().onReplyTranscript("ambiguous: which plot?");
    const notes = eventsOf(d.pushed, "linter-note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ text: "ambiguous: which plot?", segment: 1 });

    await d.fin();
    // The note rode the chronicle but NOT the committed prompt.
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].text).toContain("make the plot wider");
    expect(d.sent[0].text).not.toContain("ambiguous: which plot?");
  });

  it("reply audio pushes a speech clip", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([...opening(), ...talkSegment(1, "hello")]);
    live.callbacks().onReplyAudio(new Uint8Array([1, 2]), "audio/wav");
    const speech = d.pushed.find((m) => (m as { kind?: string }).kind === "speech") as {
      id: string;
      mime: string;
    };
    expect(speech).toMatchObject({ id: "lint_0", mime: "audio/wav" });
  });

  it("read_file round-trips: tool-call + tool-result events, respond carries the content", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aiui-lint-"));
    writeFileSync(join(cwd, "plot.ts"), "export const plot = 1;\n");
    const prev = process.env.AIUI_PROMPT_CWD;
    process.env.AIUI_PROMPT_CWD = cwd;
    try {
      const live = fakeLive();
      const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
      await d.feedEvents([...opening(), ...talkSegment(1, "check the plot helper")]);

      const responses: string[] = [];
      live.callbacks().onToolCall?.({
        tool: "read_file",
        args: { path: "plot.ts" },
        respond: (result) => responses.push(result),
      });
      expect(responses).toEqual(["export const plot = 1;\n"]);
      expect(eventsOf(d.pushed, "linter-tool-call")[0]).toMatchObject({
        tool: "read_file",
        args: { path: "plot.ts" },
      });
      expect(eventsOf(d.pushed, "linter-tool-result")[0]).toMatchObject({
        tool: "read_file",
        ok: true,
      });
    } finally {
      if (prev === undefined) {
        delete process.env.AIUI_PROMPT_CWD;
      } else {
        process.env.AIUI_PROMPT_CWD = prev;
      }
    }
  });
});

describe("context forwarding (shots, selections)", () => {
  it("a shot attachment injects a labeled image", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([
      ...opening(),
      {
        at: 5,
        type: "shot",
        marker: "shot_1",
        rect: { x: 0, y: 0, w: 10, h: 10 },
        components: [],
      },
    ]);
    await d.feedAttachment("shot_1", new Uint8Array([137, 80, 78, 71]));
    expect(live.calls.at(-1)).toEqual({ op: "injectLabeledImage", arg: "shot_1" });
  });

  it("selections inject as labels; an update reuses the id; a drop retracts", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([
      ...opening(),
      { at: 5, type: "app-selection", marker: "sel_1", text: "the histogram title" },
      { at: 6, type: "app-selection", marker: "sel_1", text: "the histogram title and axis" },
      { at: 7, type: "app-selection-drop", marker: "sel_1" },
    ]);
    const labels = live.calls.filter((c) => c.op === "injectContextText").map((c) => String(c.arg));
    expect(labels[0]).toContain('[selection sel_1: "the histogram title"');
    expect(labels[1]).toContain("[selection sel_1 updated:");
    expect(labels[2]).toBe("[selection sel_1 retracted — disregard it]");
  });
});

describe("lifecycle + posture", () => {
  it("fin closes the linter session; so does an abandoned turn", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([...opening(), ...talkSegment(1, "send this")]);
    await d.fin();
    expect(live.calls.at(-1)?.op).toBe("close");

    const live2 = fakeLive();
    const d2 = drive(LINT_HELLO, { linterSessionFactory: live2.factory });
    await d2.feedEvents([...opening(), ...talkSegment(1, "abandon this")]);
    d2.close();
    expect(live2.calls.at(-1)?.op).toBe("close");
  });

  it("keyless gemini linting degrades loudly — and dictation still works", async () => {
    // No factory, no GEMINI key (neither option nor env — see the suite-wide
    // stub above) → the sidecar never opens; one clear error. The OpenAI key IS
    // present, pinning that the gemini vendor never falls back to it.
    const d = drive(
      { transcriber: "mock", linter: "gemini" },
      { apiKey: "sk-openai-present", geminiApiKey: undefined },
    );
    await d.feedEvents([...opening(), ...talkSegment(1, "still dictating")], false);
    const error = d.pushed.find((m) => (m as { kind?: string }).kind === "error") as {
      source: string;
      message: string;
    };
    expect(error).toMatchObject({ source: "linter" });
    expect(error.message).toMatch(/GEMINI_API_KEY/);
    expect(error.message).toMatch(/dictation still works/);

    await d.fin();
    expect(d.sent).toHaveLength(1); // the turn still lowers
    expect(d.sent[0].text).toContain("still dictating");
  });

  it("coerces legacy hellos: submode realtime → linter (vendor kept), voice → realtime STT + linter", async () => {
    // A pre-pivot live-gemini hello: the composer is gone, but the vendor the
    // human picked becomes their linter, keeping the model they chose.
    const live = fakeLive();
    const d = drive(
      {
        transcriber: "mock",
        submode: "realtime",
        liveVendor: "gemini",
        liveModel: "gemini-3.1-flash-live-preview",
      },
      { linterSessionFactory: live.factory },
    );
    await d.feedEvents([...opening(), ...talkSegment(1, "legacy live turn")]);
    // The sidecar opened (the factory was used) and observes the turn.
    expect(live.calls.map((c) => c.op)).toContain("activityStart");
    await d.fin();
    // The prompt was COMPILER-composed (no submit_intent machinery left).
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].text).toContain("legacy live turn");
  });
});

describe("the Scribe default's whisper fallback", () => {
  it("falls back to openai-realtime with a NOTE (not an error) when only the OpenAI side is available", async () => {
    const d = drive(
      { transcriber: "elevenlabs" },
      {
        apiKey: "sk-present",
        elevenLabsApiKey: "",
        // The OpenAI realtime seam is present → whisper is genuinely available.
        realtimeSocketFactory: () => ({ send: () => {}, close: () => {} }),
      },
    );
    await d.feedEvents([...opening()]);
    const notes = eventsOf(d.pushed, "note").map((n) => (n as { text?: string }).text ?? "");
    expect(notes.some((t) => /Scribe unavailable/.test(t) && /Realtime Whisper/.test(t))).toBe(
      true,
    );
    expect(d.pushed.some((m) => (m as { kind?: string }).kind === "error")).toBe(false);
  });
});
