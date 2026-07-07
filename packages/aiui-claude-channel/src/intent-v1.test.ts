import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IntentEvent } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { describe, expect, it } from "vitest";
import type { ChannelFormat, ThreadContext } from "./channel";
import { type Corrector, mockCorrector } from "./correct";
import type { ChunkDescriptor, HelloMeta } from "./frame";
import { createIntentV1Format, type LoweredPromptMessage } from "./intent-v1";
import { defaultFormats } from "./processors";
import type { Summarizer } from "./summarize";
import { createTraceStore, listTraces } from "./trace";
import { withTracing } from "./tracing";
import { mockTranscriber, type Transcriber } from "./transcribe";

const enc = new TextEncoder();

const fixturesDir = fileURLToPath(
  new URL("../../aiui-dev-overlay/workbench/fixtures/", import.meta.url),
);
const loadFixture = (name: string): IntentEvent[] =>
  JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as IntentEvent[];

interface SentPrompt {
  text: string;
  meta?: Record<string, string>;
}

interface Driver {
  feedEvents(events: IntentEvent[], fin?: boolean): Promise<void>;
  feedAttachment(id: string, mime: string, bytes: Uint8Array, fin?: boolean): Promise<void>;
  feedContext(selection: unknown, fin?: boolean): Promise<void>;
  fin(): Promise<void>;
  sent: SentPrompt[];
  pushed: unknown[];
  /** The relative order of side effects: `"sent"` and `"push <kind>"` markers. */
  timeline: string[];
  isClosed(): boolean;
}

interface DriveOptions {
  hello?: HelloMeta;
  transcriber?: Transcriber;
  corrector?: Corrector;
  /** Test seam for the post-send turn summarizer (see summarize.ts). */
  summarizer?: Summarizer;
  /** Force the env key (e.g. `""` to exercise the keyless/degraded seam). */
  apiKey?: string;
  /** When set, wrap the format in tracing rooted here so blob paths resolve. */
  cache?: string;
}

/** Drive an intent-v1 processor directly, as the channel connection would. */
function drive(opts: DriveOptions = {}): Driver {
  const sent: SentPrompt[] = [];
  const pushed: unknown[] = [];
  const timeline: string[] = [];
  let closed = false;
  const ctx: ThreadContext = {
    threadId: "t-1",
    ...(opts.hello !== undefined ? { hello: opts.hello } : {}),
    sendPrompt: (text, meta) => {
      sent.push({ text, ...(meta !== undefined ? { meta } : {}) });
      timeline.push("sent");
    },
    push: (message) => {
      pushed.push(message);
      timeline.push(`push ${(message as { kind?: string }).kind}`);
    },
    close: () => {
      closed = true;
    },
  };

  let format: ChannelFormat = createIntentV1Format({
    ...(opts.transcriber !== undefined ? { transcriber: opts.transcriber } : {}),
    ...(opts.corrector !== undefined ? { corrector: opts.corrector } : {}),
    ...(opts.summarizer !== undefined ? { summarizer: opts.summarizer } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  });
  if (opts.cache !== undefined) {
    format = withTracing(new Map([["intent-v1", format]]), createTraceStore(opts.cache)).get(
      "intent-v1",
    ) as ChannelFormat;
  }
  const processor = format.createProcessor(ctx);

  const send = (payload: Uint8Array, chunk: ChunkDescriptor | undefined, fin: boolean) =>
    processor.onMessage(payload, { fin, ...(chunk !== undefined ? { chunk } : {}) });

  return {
    feedEvents: (events, fin = false) =>
      send(enc.encode(JSON.stringify({ events })), { kind: "events" }, fin),
    feedAttachment: (id, mime, bytes, fin = false) =>
      send(bytes, { kind: "attachment", id, mime }, fin),
    feedContext: (selection, fin = false) =>
      send(enc.encode(JSON.stringify({ selection })), { kind: "context" }, fin),
    fin: () => send(new Uint8Array(0), undefined, true),
    sent,
    pushed,
    timeline,
    isClosed: () => closed,
  };
}

const openaiHello = (over: Record<string, unknown> = {}): HelloMeta => ({
  intent: { transcriber: "openai", corrector: "openai", correctionPolicy: "replace", ...over },
});

describe("intent-v1 registration", () => {
  it("is registered in the default format registry alongside text-concat", () => {
    const formats = defaultFormats();
    expect([...formats.keys()].sort()).toEqual(["intent-v1", "text-concat"]);
  });
});

describe("intent-v1 lowering — fixtures", () => {
  it("plain-dictation: two segments joined by space, no attachments", async () => {
    const d = drive();
    await d.feedEvents(loadFixture("plain-dictation.json"));
    await d.fin();
    expect(d.isClosed()).toBe(true);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].text).toBe(
      "make the baseline curve a bit thicker and color it amber " +
        "the legend overlaps the plot on narrow screens can you move it below",
    );
    // No shots → no Option-C meta.
    expect(d.sent[0].meta).toBeUndefined();
  });

  it("dictation-typed-correction: applies the V4A patch (base line → baseline)", async () => {
    const d = drive();
    await d.feedEvents(loadFixture("dictation-typed-correction.json"));
    await d.fin();
    expect(d.sent).toHaveLength(1);
    // by-space final prompt over the by-line-patched document.
    expect(d.sent[0].text).toContain("baseline");
    expect(d.sent[0].text).not.toContain("base line");
  });

  it("ink-and-region-shot: a shot with no attachment degrades to an inline reference", async () => {
    const d = drive();
    await d.feedEvents(loadFixture("ink-and-region-shot.json"));
    await d.fin();
    expect(d.sent).toHaveLength(1);
    // No pixels were captured → degraded inline reference, element info in the text.
    expect(d.sent[0].text).toContain('<screenshot marker="shot_1" missing="image not captured"');
    expect(d.sent[0].meta).toBeUndefined();
  });

  it("full-turn-send: a shot attachment is inlined at its position with its path", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-intent-"));
    const d = drive({ cache });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    await d.feedEvents(loadFixture("full-turn-send.json"));
    await d.feedAttachment("shot_1", "image/png", png);
    await d.fin();

    expect(d.sent).toHaveLength(1);
    const { text, meta } = d.sent[0];
    // Both dictated segments survive, with the reference positioned between them.
    expect(text).toContain("make the baseline curve");
    expect(text).toContain("the legend overlaps the plot");
    // The path is inlined in the text (the temp cache is outside the compose
    // cwd, so it stays absolute), the blob was actually written, and there is
    // no meta block anymore — everything the agent needs is in the sentence.
    const inlinePath = /<screenshot path="([^"]+)"/.exec(text)?.[1];
    expect(inlinePath).toBeDefined();
    expect(isAbsolute(inlinePath ?? "")).toBe(true);
    expect(existsSync(inlinePath ?? "")).toBe(true);
    expect([...readFileSync(inlinePath ?? "")]).toEqual([...png]);
    expect(meta).toBeUndefined();

    // The whole lowering was traced (info → merged events → composed → conditioned → output).
    const [trace] = listTraces(cache);
    const labels = trace.stages.map((s) => s.label);
    expect(labels).toContain("intent config");
    expect(labels).toContain("merged events");
    expect(labels).toContain("composed intent");
    expect(labels).toContain("conditioned");
    expect(labels).toContain("lowered prompt");
  });

  it("cancel-turn: an Esc-cancelled thread lowers to no notification", async () => {
    const d = drive();
    await d.feedEvents(loadFixture("cancel-turn.json"));
    await d.fin();
    expect(d.isClosed()).toBe(true);
    expect(d.sent).toEqual([]);
    expect(d.pushed).toEqual([]);
  });
});

describe("intent-v1 cost accounting", () => {
  it("records a cost stage per priced call and rolls the manifest total up", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-cost-"));
    const d = drive({
      cache,
      hello: openaiHello({ transcriber: "openai" }),
      transcriber: {
        name: "priced-mock",
        transcribe: async () => ({
          text: "make the plot wider",
          latencyMs: 5,
          model: "gpt-4o-mini-transcribe",
          // The shape a real seam produces (see transcribe.ts + cost.ts).
          cost: {
            usd: 0.000455,
            provider: "openai",
            model: "gpt-4o-mini-transcribe",
            usage: { input_tokens: 120, input_audio_tokens: 120, output_tokens: 19 },
          },
        }),
      },
    });
    await d.feedEvents([
      { at: 1, type: "armed", on: true },
      { at: 2, type: "thread-open", trigger: "talk" },
      { at: 3, type: "talk-start", segment: 1 },
      { at: 4, type: "talk-end", segment: 1, ms: 300 },
    ]);
    await d.feedAttachment("seg_1", "audio/webm;codecs=opus", new Uint8Array([1, 2, 3]));
    await d.fin();

    const [trace] = listTraces(cache);
    // The call got its 💰 stage…
    const cost = trace.stages.find((st) => st.label === "cost: transcription seg_1");
    expect(cost).toBeDefined();
    expect((cost?.data as { usd?: number }).usd).toBeCloseTo(0.000455, 6);
    // …and the manifest carries the roll-up (one priced call here).
    expect(trace.costUsd).toBeCloseTo(0.000455, 6);
  });
});

describe("intent-v1 turn summary", () => {
  const mockSummarizer = (line: string): Summarizer => ({
    name: "mock",
    summarize: async () => ({ text: line }),
  });
  // The summary is fired detached after the send; let its microtasks settle.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("writes the summarizer's line onto the trace manifest after a sent turn", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-summary-"));
    const d = drive({ cache, summarizer: mockSummarizer("rewrite the essay to say vite") });
    await d.feedEvents(loadFixture("plain-dictation.json"));
    await d.fin();
    expect(d.sent).toHaveLength(1);
    await settle();

    const [trace] = listTraces(cache);
    expect(trace.summary).toBe("rewrite the essay to say vite");
    // The summary rides *on top of* a finished trace — status is unaffected.
    expect(trace.status).toBe("completed");
  });

  it("summarizes the body only — no preamble text reaches the seam", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-summary-"));
    let seen: string | undefined;
    const spy: Summarizer = {
      name: "spy",
      summarize: async (body) => {
        seen = body;
        return { text: "gloss" };
      },
    };
    const d = drive({
      cache,
      summarizer: spy,
      hello: { source: { root: "/proj" }, intent: {} } as HelloMeta,
    });
    await d.feedEvents(loadFixture("plain-dictation.json"));
    await d.fin();
    await settle();
    // wrapWithContext's preamble ("This prompt was sent from …") is excluded.
    expect(seen).toBeDefined();
    expect(seen).not.toContain("This prompt was sent from");
    expect(seen).toContain("make the baseline curve");
  });

  it("records no summary for a cancelled turn (nothing was sent)", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-summary-"));
    const d = drive({ cache, summarizer: mockSummarizer("should not appear") });
    await d.feedEvents(loadFixture("cancel-turn.json"));
    await d.fin();
    await settle();
    const [trace] = listTraces(cache);
    expect(trace.summary).toBeUndefined();
  });

  it("records no summary when keyless with no seam", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-summary-"));
    const d = drive({ cache, apiKey: "" });
    await d.feedEvents(loadFixture("plain-dictation.json"));
    await d.fin();
    await settle();
    const [trace] = listTraces(cache);
    expect(trace.summary).toBeUndefined();
  });
});

describe("intent-v1 lowered-prompt push", () => {
  it("pushes the composed prompt on fin, before the session notification", async () => {
    const d = drive();
    await d.feedEvents(loadFixture("plain-dictation.json"));
    await d.fin();

    expect(d.sent).toHaveLength(1);
    // The pushed prompt is exactly what sendPrompt committed (no meta: no shots).
    expect(d.pushed).toEqual([{ kind: "lowered-prompt", threadId: "t-1", prompt: d.sent[0].text }]);
    // …and it went out before the notification, so a widget's view never lags.
    expect(d.timeline).toEqual(["push lowered-prompt", "sent"]);
  });

  it("shows the committed prompt with the shot path inlined (no meta block)", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-intent-"));
    const d = drive({ cache });
    await d.feedEvents(loadFixture("full-turn-send.json"));
    await d.feedAttachment("shot_1", "image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    await d.fin();

    const message = d.pushed.find(
      (m) => (m as { kind?: string }).kind === "lowered-prompt",
    ) as LoweredPromptMessage;
    expect(message.prompt).toBe(d.sent[0].text);
    expect(message.prompt).toContain('<screenshot path="');
    expect(message.meta).toBeUndefined();
    expect(d.sent[0].meta).toBeUndefined();
  });
});

describe("intent-v1 server transcription", () => {
  it("transcribes a seg_N attachment and pushes a lowered transcript-final", async () => {
    const d = drive({
      hello: openaiHello({ transcriber: "openai" }),
      transcriber: mockTranscriber(() => "make the plot wider"),
    });
    await d.feedEvents([
      { at: 1, type: "armed", on: true },
      { at: 2, type: "thread-open", trigger: "talk" },
      { at: 3, type: "talk-start", segment: 1 },
      { at: 4, type: "talk-end", segment: 1, ms: 300 },
    ]);
    await d.feedAttachment("seg_1", "audio/webm;codecs=opus", new Uint8Array([1, 2, 3]));

    expect(d.pushed).toHaveLength(1);
    expect(d.pushed[0]).toMatchObject({
      kind: "lowered",
      threadId: "t-1",
      events: [
        { type: "transcript-final", segment: 1, text: "make the plot wider", model: "mock" },
      ],
    });
    const pushedEvent = (d.pushed[0] as { events: IntentEvent[] }).events[0];
    expect(typeof (pushedEvent as { latencyMs: number }).latencyMs).toBe("number");

    // The server-produced transcript is merged into the stream and lowered.
    await d.fin();
    expect(d.sent[0].text).toBe("make the plot wider");
  });

  it("skips transcription when the hello did not ask for the openai transcriber", async () => {
    const d = drive({
      hello: { intent: { transcriber: "mock" } },
      transcriber: mockTranscriber(() => "should not run"),
    });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
    ]);
    await d.feedAttachment("seg_1", "audio/webm", new Uint8Array([1]));
    expect(d.pushed).toEqual([]);
  });

  it("echoes a note (not silence) when openai transcription is asked for but the channel is keyless", async () => {
    // openai requested, no override, forced-empty key → the transcriber seam is
    // absent. The default is `openai`, so a keyless launch lands here.
    const d = drive({ hello: openaiHello({ transcriber: "openai" }), apiKey: "" });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
      { at: 3, type: "talk-end", segment: 1, ms: 200 },
    ]);
    await d.feedAttachment("seg_1", "audio/webm", new Uint8Array([1, 2, 3]));

    expect(d.pushed).toHaveLength(2);
    const events = (d.pushed[0] as { events: IntentEvent[] }).events;
    expect(events.map((e) => e.type)).toEqual(["transcript-final", "note"]);
    // The segment resolves to an empty final so the preview doesn't hang…
    expect((events[0] as Extract<IntentEvent, { type: "transcript-final" }>).text).toBe("");
    // …the note names the cause the widget can show…
    expect((events[1] as Extract<IntentEvent, { type: "note" }>).text).toMatch(/OPENAI_API_KEY/);
    // …and the generic error push carries the same cause to the toast surface
    // (the note only reaches the panel-footer status line — closed = invisible).
    expect(d.pushed[1]).toMatchObject({
      kind: "error",
      threadId: "t-1",
      source: "transcription",
      message: expect.stringMatching(/OPENAI_API_KEY/),
    });
  });

  it("echoes a note when server-side transcription throws (e.g. an invalid key)", async () => {
    const throwing: Transcriber = {
      name: "throwing",
      async transcribe() {
        throw new Error("transcription failed (401)");
      },
    };
    const d = drive({ hello: openaiHello({ transcriber: "openai" }), transcriber: throwing });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
    ]);
    // The throw is caught inside the processor — the frame is not rejected.
    await d.feedAttachment("seg_1", "audio/webm", new Uint8Array([1, 2, 3]));

    expect(d.pushed).toHaveLength(2);
    const events = (d.pushed[0] as { events: IntentEvent[] }).events;
    expect(events.map((e) => e.type)).toEqual(["transcript-final", "note"]);
    expect((events[1] as Extract<IntentEvent, { type: "note" }>).text).toMatch(
      /transcription failed.*401/,
    );
    // The stale/invalid-key scenario: the error push names the failure AND
    // points at the fix (the key hint) — the toast the user actually sees.
    expect(d.pushed[1]).toMatchObject({
      kind: "error",
      threadId: "t-1",
      source: "transcription",
      message: expect.stringMatching(/transcription failed.*401/),
      detail: expect.stringMatching(/OPENAI_API_KEY/),
    });
  });
});

describe("intent-v1 server correction", () => {
  const base = (): IntentEvent[] => [
    { at: 1, type: "armed", on: true },
    { at: 2, type: "thread-open", trigger: "talk" },
    { at: 3, type: "talk-start", segment: 1 },
    { at: 4, type: "talk-end", segment: 1, ms: 300 },
    {
      at: 5,
      type: "transcript-final",
      segment: 1,
      text: "make the base line curve a bit thicker",
      latencyMs: 300,
      model: "mock",
    },
  ];

  it("runs the diff for a patchless correction and pushes the completed event", async () => {
    const d = drive({ hello: openaiHello({ corrector: "openai" }), corrector: mockCorrector() });
    await d.feedEvents([
      ...base(),
      {
        at: 6,
        type: "correction",
        from: 9,
        to: 18,
        original: "base line",
        instruction: "baseline",
        via: "typed",
      },
    ]);

    expect(d.pushed).toHaveLength(1);
    const event = (d.pushed[0] as { events: IntentEvent[] }).events[0] as Extract<
      IntentEvent,
      { type: "correction" }
    >;
    expect(event.type).toBe("correction");
    expect(event.original).toBe("base line");
    expect(event.instruction).toBe("baseline");
    expect(event.via).toBe("typed");
    expect(event.patch).toContain("*** Begin Patch");
    expect(event.model).toBe("mock");
    expect(typeof event.latencyMs).toBe("number");

    await d.fin();
    expect(d.sent[0].text).toContain("baseline");
    expect(d.sent[0].text).not.toContain("base line");
  });

  it("pushes the correction without a patch when the diff is malformed (no silent loss)", async () => {
    const badCorrector: Corrector = {
      name: "bad",
      async diff() {
        // A patch whose context matches nothing in the document → won't apply.
        return {
          patch:
            "*** Begin Patch\n*** Update File: transcript\n@@\n-no such line\n+x\n*** End Patch",
          model: "bad",
          latencyMs: 1,
        };
      },
    };
    const d = drive({ hello: openaiHello({ corrector: "openai" }), corrector: badCorrector });
    await d.feedEvents([
      ...base(),
      {
        at: 6,
        type: "correction",
        from: 9,
        to: 18,
        original: "base line",
        instruction: "baseline",
        via: "typed",
      },
    ]);

    expect(d.pushed).toHaveLength(2);
    const event = (d.pushed[0] as { events: IntentEvent[] }).events[0] as Extract<
      IntentEvent,
      { type: "correction" }
    >;
    expect(event.patch).toBeUndefined();
    // The fallback is no longer silent about WHY: the generic error push names
    // the cause (here: the model's patch would not apply).
    expect(d.pushed[1]).toMatchObject({
      kind: "error",
      threadId: "t-1",
      source: "correction",
      message: expect.stringMatching(/plain replacement/),
    });

    // Falls back to plain first-occurrence replacement — the correction still lands.
    await d.fin();
    expect(d.sent[0].text).toContain("baseline");
  });

  it("pushes an error naming the cause when the corrector itself throws (stale key)", async () => {
    const throwing: Corrector = {
      name: "throws",
      async diff() {
        throw new Error("Incorrect API key provided (401)");
      },
    };
    const d = drive({ hello: openaiHello({ corrector: "openai" }), corrector: throwing });
    await d.feedEvents([
      ...base(),
      {
        at: 6,
        type: "correction",
        from: 9,
        to: 18,
        original: "base line",
        instruction: "baseline",
        via: "typed",
      },
    ]);

    // The patchless fallback still lands (never a vanished correction)…
    const echoed = (d.pushed[0] as { events: IntentEvent[] }).events[0] as Extract<
      IntentEvent,
      { type: "correction" }
    >;
    expect(echoed.patch).toBeUndefined();
    // …and the API error surfaces with the remediation hint instead of dying
    // in the catch (the failure mode this feature exists for).
    expect(d.pushed[1]).toMatchObject({
      kind: "error",
      source: "correction",
      message: expect.stringMatching(/Incorrect API key.*401/),
      detail: expect.stringMatching(/OPENAI_API_KEY/),
    });
  });

  it("passes a correction that already carries a patch straight through", async () => {
    // Mock-transcriber turns (the captured fixtures) carry their own patch and
    // must not trigger a server diff — the corrector below would throw if asked.
    const throwingCorrector: Corrector = {
      name: "throws",
      async diff() {
        throw new Error("should not be called");
      },
    };
    const d = drive({ hello: openaiHello({ corrector: "openai" }), corrector: throwingCorrector });
    await d.feedEvents(loadFixture("dictation-typed-correction.json"));
    await d.fin();
    // No server-produced events (the client's patch was used as-is) — the only
    // push is the fin's lowered-prompt.
    expect(d.pushed.map((m) => (m as { kind: string }).kind)).toEqual(["lowered-prompt"]);
    expect(d.sent[0].text).toContain("baseline");
  });
});

describe("intent-v1 incremental lowering (S1)", () => {
  /** The `reused` flag the fin lowering records — true = speculative cache hit. */
  const finReused = (cache: string): boolean => {
    const [trace] = listTraces(cache);
    const stage = trace.stages.find((s) => s.label === "fin compose");
    return (stage?.data as { reused: boolean }).reused;
  };

  it("reuses the speculative compose at fin when the event log is unchanged since", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-intent-"));
    const d = drive({ cache });
    // One events batch composes speculatively; the bare fin adds no events.
    await d.feedEvents(loadFixture("plain-dictation.json"));
    await d.fin();

    // The output is the same as ever…
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].text).toBe(
      "make the baseline curve a bit thicker and color it amber " +
        "the legend overlaps the plot on narrow screens can you move it below",
    );
    // …and it came from the cache, not a fin-time recompute.
    expect(finReused(cache)).toBe(true);
  });

  it("recomputes at fin when a shot path is wired after the last events batch", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-intent-"));
    const d = drive({ cache });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
    // Batch (shot event, no path yet → speculative degraded reference), then the
    // bytes land and wire the path — the one late mutation between batch and fin.
    await d.feedEvents(loadFixture("full-turn-send.json"));
    await d.feedAttachment("shot_1", "image/png", png);
    await d.fin();

    // The wired path made it into the committed prompt, inlined…
    expect(d.sent).toHaveLength(1);
    const inlinePath = /<screenshot path="([^"]+)"/.exec(d.sent[0].text)?.[1];
    expect(inlinePath).toBeDefined();
    expect(existsSync(inlinePath ?? "")).toBe(true);
    // …which required a fin-time recompute (the cache was stale).
    expect(finReused(cache)).toBe(false);
  });

  it("saves a shot blob to the trace dir on arrival, before fin", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-intent-"));
    const d = drive({ cache });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    await d.feedEvents(loadFixture("full-turn-send.json"));
    await d.feedAttachment("shot_1", "image/png", png); // no fin yet

    // The bytes are already on disk while the turn is still open.
    const [trace] = listTraces(cache);
    const blob = join(cache, "traces", trace.id, "shot_1.png");
    expect(existsSync(blob)).toBe(true);
    expect([...readFileSync(blob)]).toEqual([...png]);
    // The turn has not committed yet — no prompt, thread still open.
    expect(d.sent).toEqual([]);
    expect(d.isClosed()).toBe(false);

    await d.fin();
    expect(d.sent).toHaveLength(1);
  });

  it("records incremental stages in arrival order (blob + speculative compose precede fin)", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-intent-"));
    const d = drive({ cache });
    await d.feedEvents(loadFixture("full-turn-send.json"));
    await d.feedAttachment("shot_1", "image/png", new Uint8Array([0x89, 1, 2, 3]));
    await d.fin();

    const [trace] = listTraces(cache);
    const at = (label: string): number => trace.stages.findIndex((s) => s.label === label);
    // The blob was recorded on the attachment frame, before the fin frame.
    expect(at("attachment shot_1")).toBeGreaterThanOrEqual(0);
    expect(at("attachment shot_1")).toBeLessThan(at("frame 2 (fin)"));
    // The speculative compose ran during the turn, before the fin lowering.
    expect(at("composed (speculative)")).toBeGreaterThanOrEqual(0);
    expect(at("composed (speculative)")).toBeLessThan(at("merged events"));
    // The condition pass ran on arrival too.
    expect(at("condition shot_1 (imageDownscale)")).toBeLessThan(at("frame 2 (fin)"));
  });
});

describe("intent-v1 malformed input", () => {
  it("rejects an events chunk that is not a JSON events batch", async () => {
    const d = drive();
    await expect(d.feedEvents(undefined as unknown as IntentEvent[])).rejects.toThrow(/events/);
  });
});

describe("intent-v1 lowering — selections", () => {
  const seg = (at: number, text: string): IntentEvent => ({
    at,
    type: "transcript-final",
    segment: 1,
    text,
    latencyMs: 5,
    model: "mock",
  });
  const open = (at = 1): IntentEvent => ({ at, type: "thread-open", trigger: "talk" });

  it("lowers the stream's app-selection event into the context preamble", async () => {
    const d = drive();
    await d.feedEvents([
      open(),
      {
        at: 2,
        type: "app-selection",
        text: "reaction-diffusion on the GPU",
        sourceLoc: "src/ui/App.tsx:35:13",
        cell: "catalog",
      },
      seg(3, "make this wider"),
    ]);
    await d.fin();
    expect(d.sent).toHaveLength(1);
    // Identical wording to text-concat's selection block (prompt-context.ts).
    expect(d.sent[0].text).toContain(
      'It concerns this on-screen selection: "reaction-diffusion on the GPU" ' +
        "(authored at src/ui/App.tsx:35:13; produced by cell catalog).",
    );
    // Context, not intent: the body itself is only the spoken words.
    expect(d.sent[0].text.split("---")[1]?.trim()).toBe("make this wider");
  });

  it("prefers the stream's selection over a legacy context chunk, which stays the fallback", async () => {
    const d = drive();
    await d.feedContext({ text: "stale send-time selection" });
    await d.feedEvents([
      open(),
      { at: 2, type: "app-selection", text: "the fresh selection" },
      seg(3, "explain this"),
    ]);
    await d.fin();
    expect(d.sent[0].text).toContain('It concerns this on-screen selection: "the fresh selection"');
    expect(d.sent[0].text).not.toContain("stale send-time selection");

    // An old client that only sends the context chunk still gets the preamble.
    const legacy = drive();
    await legacy.feedEvents([open(), seg(2, "explain this")]);
    await legacy.feedContext({ text: "context-chunk selection", cell: "flow" });
    await legacy.fin();
    expect(legacy.sent[0].text).toContain(
      'It concerns this on-screen selection: "context-chunk selection" (produced by cell flow).',
    );
  });

  it("honors an app-selection-drop: the retracted selection never reaches the prompt", async () => {
    const d = drive();
    await d.feedEvents([
      open(),
      { at: 2, type: "app-selection", text: "changed my mind" },
      seg(3, "just do the thing"),
      { at: 4, type: "app-selection-drop" },
    ]);
    await d.fin();
    expect(d.sent[0].text).toBe("just do the thing");
  });

  it("renders a code-selection event into the body at its position (short → inline)", async () => {
    const d = drive();
    await d.feedEvents([
      open(),
      seg(2, "rename this helper"),
      {
        at: 3,
        type: "code-selection",
        text: "export function curb() {}",
        sourceLoc: "src/c.ts:12:1",
        lines: 1,
      },
    ]);
    await d.fin();
    expect(d.sent[0].text).toBe(
      "rename this helper Regarding `src/c.ts:12:1`: `export function curb() {}`",
    );
  });

  it("records first-class trace stages for both selection kinds", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-sel-"));
    const d = drive({ cache });
    await d.feedEvents([
      open(),
      { at: 2, type: "app-selection", text: "the histogram title", cell: "hist" },
      seg(3, "make it bigger"),
      { at: 4, type: "code-selection", text: "const s = 1;", sourceLoc: "src/s.ts:1:1" },
    ]);
    await d.fin();
    const [trace] = listTraces(cache);
    const appStage = trace.stages.find((s) => s.label === "app selection");
    expect(appStage?.data).toMatchObject({ text: "the histogram title", cell: "hist" });
    const codeStage = trace.stages.find((s) => s.label === "code selection");
    expect(codeStage?.data).toMatchObject({ text: "const s = 1;", sourceLoc: "src/s.ts:1:1" });
  });
});
