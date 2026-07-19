/**
 * The prompt-linter sidecar, driven through the UNIFIED intent processor —
 * the wire-order contracts of the CONVERSE-ONLY linter (overhear retired
 * 2026-07-19):
 *
 *  - the linter ACCUMULATES: one vendor window across talk segments, finals
 *    injected as silent context as they land, and NO activityEnd until the
 *    `lint now` control (the lint judges the compiler's transcription, not
 *    just its own hearing);
 *  - every completed lint pushes `linter-turn-complete`, and the linter
 *    STAYS ON (the select is the only off switch);
 *  - `lint stop` cancels the in-flight reply and nothing else;
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
import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelFormat, MessageMeta, StreamProcessor, ThreadContext } from "./channel";
import type { ChunkDescriptor } from "./frame";
import { createIntentV1Format, type IntentV1Options } from "./intent-v1";
import type { LiveSession, LiveSessionCallbacks } from "./live-session";

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
    Promise.resolve(
      processor.onMessage(payload, {
        fin,
        ...(chunk !== undefined ? { chunk } : {}),
      } as MessageMeta),
    );
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

describe("accumulation (converse-only wire order)", () => {
  it("injects [transcript seg_N] silently and does NOT end the turn at talk-end", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([...opening(), ...talkSegment(1, "make the plot wider")]);

    const ops = live.calls.map((c) => c.op);
    expect(ops).toEqual(["cancel", "activityStart", "injectContextText"]);
    expect(live.calls[2].arg).toBe('[transcript seg_1: "make the plot wider"]');
  });

  it("accumulates ACROSS talk segments: one window, every final injected, no boundary", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([
      ...opening(),
      ...talkSegment(1, "first thought"),
      ...talkSegment(2, "second thought"),
    ]);
    const ops = live.calls.map((c) => c.op);
    expect(ops.filter((op) => op === "activityStart")).toHaveLength(1); // ONE window
    expect(ops).not.toContain("activityEnd"); // nothing but the button ends it
    const injected = live.calls.filter((c) => c.op === "injectContextText").map((c) => c.arg);
    expect(injected).toEqual([
      '[transcript seg_1: "first thought"]',
      '[transcript seg_2: "second thought"]',
    ]);
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
    // Now the sidecar exists and ACCUMULATES the second segment.
    const ops = live.calls.map((c) => c.op);
    expect(ops).toContain("activityStart");
    expect(live.calls.find((c) => c.op === "injectContextText")?.arg).toBe(
      '[transcript seg_2: "second utterance"]',
    );
  });

  it("STOPS the linter mid-thread — a control 'off' closes the sidecar; later talk lints nothing", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([...opening(), ...talkSegment(1, "first")]);
    expect(live.calls.map((c) => c.op)).toContain("injectContextText"); // it was live

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
    // The fresh sidecar accumulates seg 2 (it does not inherit seg 1).
    expect(live.calls.at(-1)).toEqual({
      op: "injectContextText",
      arg: '[transcript seg_2: "second"]',
    });
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

describe("the lint buttons — control 'lint' now/stop (the only turn trigger)", () => {
  it("'now' ends the turn AT THE BUTTON — never waiting for a pending final (the accepted race)", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    // Talk ended but the STT final never landed: the button does not care.
    await d.feedEvents([
      ...opening(),
      { at: 10, type: "talk-start", segment: 1 },
      { at: 15, type: "talk-end", segment: 1, ms: 400 },
    ]);
    expect(live.calls.filter((c) => c.op === "activityEnd")).toHaveLength(0);
    await d.feedControl("lint", "now");
    expect(live.calls.filter((c) => c.op === "activityEnd")).toHaveLength(1);
    // The vendor signals the reply is done → linter-turn-complete, anchored
    // to the turn the button ended.
    live.callbacks().onTurnComplete?.();
    expect(eventsOf(d.pushed, "linter-turn-complete")).toEqual([
      expect.objectContaining({ type: "linter-turn-complete", segment: 1 }),
    ]);
  });

  it("STAY-ON: after a completed lint, talk reopens the window and the button lints again", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([...opening(), ...talkSegment(1, "first")]);
    await d.feedControl("lint", "now");
    live.callbacks().onTurnComplete?.();
    expect(eventsOf(d.pushed, "linter-turn-complete")).toHaveLength(1);
    expect(live.calls.some((c) => c.op === "close")).toBe(false); // still on

    // Round two: the window reopens on talk, the button ends it again.
    await d.feedEvents(talkSegment(2, "second"));
    await d.feedControl("lint", "now");
    expect(live.calls.filter((c) => c.op === "activityEnd")).toHaveLength(2);
    expect(live.calls.filter((c) => c.op === "activityStart")).toHaveLength(2);
    live.callbacks().onTurnComplete?.();
    expect(eventsOf(d.pushed, "linter-turn-complete")).toHaveLength(2);
  });

  it("'stop' cancels the in-flight reply and nothing else (the linter keeps accumulating)", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([
      ...opening(),
      { at: 10, type: "talk-start", segment: 1 },
      { at: 15, type: "talk-end", segment: 1, ms: 400 },
    ]);
    await d.feedControl("lint", "now"); // reply soliciting
    const cancelsBefore = live.calls.filter((c) => c.op === "cancel").length;
    await d.feedControl("lint", "stop");
    expect(live.calls.filter((c) => c.op === "cancel").length).toBe(cancelsBefore + 1);
    expect(live.calls.some((c) => c.op === "close")).toBe(false); // still on
    // OpenAI answers a cancel with the cancelled response's done: the floor is
    // free — reported as turn-complete like any other (stay-on; harmless).
    live.callbacks().onTurnComplete?.();
    expect(eventsOf(d.pushed, "linter-turn-complete")).toHaveLength(1);
  });

  it("'now' with no open window is a no-op (nothing was said to lint)", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents(opening()); // armed, thread open — but no talk yet
    await d.feedControl("lint", "now");
    expect(live.calls.filter((c) => c.op === "activityEnd")).toHaveLength(0);
  });

  it("ignores an unrecognized lint value, and 'lint' without a sidecar", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([...opening(), { at: 10, type: "talk-start", segment: 1 }]);
    const n = live.calls.length;
    await d.feedControl("lint", "banana");
    expect(live.calls.length).toBe(n);
    // No sidecar at all (linter off): the control is a clean no-op.
    const d2 = drive({ transcriber: "mock", linter: "off" });
    await d2.feedEvents(opening());
    await d2.feedControl("lint", "now"); // must not throw
  });
});

describe("lint products (notes, audio, tools)", () => {
  it("a reply transcript becomes a linter-note (pushed + chronicled), and the compiler ignores it", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([...opening(), ...talkSegment(1, "make the plot wider")]);
    await d.feedControl("lint", "now"); // notes follow a buttoned turn

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

  it("reply audio STREAMS as seq-ordered chunks; the stream id rotates per completed turn", async () => {
    const live = fakeLive();
    const d = drive(LINT_HELLO, { linterSessionFactory: live.factory });
    await d.feedEvents([...opening(), ...talkSegment(1, "hello")]);
    live.callbacks().onReplyAudio(new Uint8Array([1, 2]), "audio/pcm;rate=24000");
    live.callbacks().onReplyAudio(new Uint8Array([3, 4]), "audio/pcm;rate=24000");
    live.callbacks().onTurnComplete?.(); // the reply finished — rotate
    live.callbacks().onReplyAudio(new Uint8Array([5, 6]), "audio/pcm;rate=24000");
    const chunks = d.pushed.filter((m) => (m as { kind?: string }).kind === "speech") as Array<{
      id: string;
      seq: number;
      mime: string;
    }>;
    expect(chunks.map((c) => ({ id: c.id, seq: c.seq }))).toEqual([
      { id: "lint_0", seq: 0 },
      { id: "lint_0", seq: 1 },
      { id: "lint_1", seq: 0 }, // the NEXT reply is a fresh stream
    ]);
    expect(chunks[0].mime).toBe("audio/pcm;rate=24000");
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
