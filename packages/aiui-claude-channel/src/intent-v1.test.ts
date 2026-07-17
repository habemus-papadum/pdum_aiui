import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import { describe, expect, it } from "vitest";
import type { ChannelFormat, ThreadContext } from "./channel";
import type { ChunkDescriptor, HelloMeta } from "./frame";
import { createIntentV1Format, type LoweredPromptMessage } from "./intent-v1";
import { defaultFormats } from "./processors";
import { TRANSCRIPTION_NOTE } from "./prompt-context";
import type { Summarizer } from "./summarize";
import { createTraceStore, listTraces } from "./trace";
import { withTracing } from "./tracing";
import { mockTranscriber, type Transcriber } from "./transcribe";

const enc = new TextEncoder();

const fixturesDir = fileURLToPath(
  new URL("../../aiui-lowering-pipeline/fixtures/", import.meta.url),
);
const loadFixture = (name: string): IntentEvent[] =>
  JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as IntentEvent[];

/**
 * A SPEECH turn's wrapped prompt under a bare hello: the transcription note is
 * the whole preamble (typed contributions never trigger it), then the rule,
 * then the body.
 */
const spoken = (body: string): string => `${TRANSCRIPTION_NOTE}\n\n---\n\n${body}`;

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
  intent: { transcriber: "openai", ...over },
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
      spoken(
        "make the baseline curve a bit thicker and color it amber " +
          "the legend overlaps the plot on narrow screens can you move it below",
      ),
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
    expect(d.sent[0].text).toContain("[screenshot shot_1 located at MISSING]");
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
    const inlinePath = /\[screenshot located at ([^ \]]+)/.exec(text)?.[1];
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
    // The pushed prompt is exactly what sendPrompt committed (no meta: no
    // shots); the spans carry the preamble region (the transcription note).
    expect(d.pushed).toEqual([
      {
        kind: "lowered-prompt",
        threadId: "t-1",
        prompt: d.sent[0].text,
        spans: [{ kind: "preamble", start: 0, end: d.sent[0].text.indexOf("make the baseline") }],
      },
    ]);
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
    expect(message.prompt).toContain("[screenshot located at ");
    expect(message.meta).toBeUndefined();
    expect(d.sent[0].meta).toBeUndefined();
  });

  it("pushes spans that slice the wrapped prompt (shot block + shifted past the preamble)", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-intent-"));
    // A source-root hello produces a context preamble, so the body spans get
    // shifted — exercising the preambleLen > 0 path, not just the bare case.
    const d = drive({ cache, hello: { source: { root: "/proj" }, intent: {} } as HelloMeta });
    await d.feedEvents(loadFixture("full-turn-send.json"));
    await d.feedAttachment("shot_1", "image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    await d.fin();

    const message = d.pushed.find(
      (m) => (m as { kind?: string }).kind === "lowered-prompt",
    ) as LoweredPromptMessage;
    expect(message.spans).toBeDefined();
    const spans = message.spans ?? [];
    // Every span's offsets land inside the wrapped prompt and slice their kind.
    for (const span of spans) {
      expect(span.start).toBeGreaterThanOrEqual(0);
      expect(span.end).toBeLessThanOrEqual(message.prompt.length);
      const sliced = message.prompt.slice(span.start, span.end);
      if (span.kind === "shot") {
        // The shot span brackets the screenshot block even though it sits
        // AFTER the context preamble — i.e. the preamble shift is correct.
        expect(sliced).toContain("[screenshot located at");
      } else if (span.kind === "preamble") {
        expect(span.start).toBe(0);
        expect(sliced).toContain("This prompt was sent from the aiui intent tool");
      }
    }
    // There is at least one shot span to have exercised the offset math.
    expect(spans.some((s) => s.kind === "shot")).toBe(true);
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
    expect(d.sent[0].text).toBe(spoken("make the plot wider"));
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
      spoken(
        "make the baseline curve a bit thicker and color it amber " +
          "the legend overlaps the plot on narrow screens can you move it below",
      ),
    );
    // …and it came from the cache, not a fin-time recompute.
    expect(finReused(cache)).toBe(true);
  });

  it("refreshes the compose when a shot's bytes land, so fin reuses it", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-intent-"));
    const d = drive({ cache });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
    // Batch (shot event, no path yet → speculative degraded reference), then
    // the bytes land and wire the path. Since 2026-07-12 the wiring also
    // refreshes the compose cache immediately — the LIVE fold showed
    // "(image not captured)" one shot behind otherwise (each shot's fold
    // rendered before its bytes arrived; observed live in the trace hero).
    await d.feedEvents(loadFixture("full-turn-send.json"));
    await d.feedAttachment("shot_1", "image/png", png);
    await d.fin();

    // The wired path made it into the committed prompt, inlined…
    expect(d.sent).toHaveLength(1);
    const inlinePath = /\[screenshot located at ([^ \]]+)/.exec(d.sent[0].text)?.[1];
    expect(inlinePath).toBeDefined();
    expect(existsSync(inlinePath ?? "")).toBe(true);
    // …and fin REUSED the cache: the attachment-arrival recompose already
    // held the path, so there was nothing stale left for fin to redo.
    expect(finReused(cache)).toBe(true);
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

  it("renders the stream's app-selection INLINE in the body at its stream position", async () => {
    const d = drive();
    await d.feedEvents([
      open(),
      {
        at: 2,
        type: "app-selection",
        marker: "sel_1",
        text: "reaction-diffusion on the GPU",
        sourceLoc: "src/ui/App.tsx:35:13",
        cell: "catalog",
      },
      seg(3, "make this wider"),
    ]);
    await d.fin();
    expect(d.sent).toHaveLength(1);
    // The selection is intent, placed where it happened in the stream —
    // BEFORE the spoken words here — with the attribution wording inline.
    expect(d.sent[0].text).toBe(
      spoken(
        '[selected text: "reaction-diffusion on the GPU"]\n' +
          '<selection-metadata source="src/ui/App.tsx:35:13">\n' +
          '  <cell name="catalog"/>\n' +
          "</selection-metadata>\n\n" +
          "make this wider",
      ),
    );
    // No preamble section: the stream path never rides selectionSections.
    expect(d.sent[0].text).not.toContain("It concerns this on-screen selection");
  });

  it("composes multiple interleaved selections at position; drops retract exactly one", async () => {
    const d = drive();
    await d.feedEvents([
      open(),
      seg(2, "make this wider"),
      { at: 3, type: "app-selection", marker: "sel_1", text: "the histogram title" },
      {
        at: 4,
        type: "transcript-final",
        segment: 2,
        text: "and match this",
        latencyMs: 5,
        model: "mock",
      },
      { at: 5, type: "app-selection", marker: "sel_2", text: "the legend caption" },
      { at: 6, type: "app-selection-drop", marker: "sel_1" },
    ]);
    await d.fin();
    expect(d.sent[0].text).toBe(
      spoken('make this wider and match this [selected text: "the legend caption"]'),
    );
  });

  it("ignores the legacy context chunk entirely (selections ride the stream now)", async () => {
    const d = drive();
    await d.feedContext({ text: "stale send-time selection" });
    await d.feedEvents([
      open(),
      { at: 2, type: "app-selection", marker: "sel_1", text: "the fresh selection" },
      seg(3, "explain this"),
    ]);
    await d.fin();
    // The stream's selection rides the body inline; the legacy chunk is
    // accepted (old clients still get their frame acked) and ignored.
    expect(d.sent[0].text).toContain('[selected text: "the fresh selection"]');
    expect(d.sent[0].text).not.toContain("stale send-time selection");

    // Even a turn with ONLY the legacy chunk lowers without it — the
    // preamble selection path was retired in the render audit.
    const legacy = drive();
    await legacy.feedEvents([open(), seg(2, "explain this")]);
    await legacy.feedContext({ text: "context-chunk selection", cell: "flow" });
    await legacy.fin();
    expect(legacy.sent[0].text).toBe(spoken("explain this"));
    expect(legacy.sent[0].text).not.toContain("context-chunk selection");
  });

  it("tolerates pre-marker streams: a markerless drop retracts the latest selection", async () => {
    const d = drive();
    await d.feedEvents([
      open(),
      { at: 2, type: "app-selection", text: "changed my mind" },
      seg(3, "just do the thing"),
      { at: 4, type: "app-selection-drop" },
    ]);
    await d.fin();
    expect(d.sent[0].text).toBe(spoken("just do the thing"));
  });

  it("renders a code-selection event into the body at its position (short → inline)", async () => {
    const d = drive();
    await d.feedEvents([
      open(),
      seg(2, "rename this helper"),
      {
        at: 3,
        type: "code-selection",
        marker: "code_1",
        text: "export function curb() {}",
        sourceLoc: "src/c.ts:12:1",
        lines: 1,
      },
    ]);
    await d.fin();
    expect(d.sent[0].text).toBe(
      spoken("rename this helper [code selection at `src/c.ts:12:1`: `export function curb() {}`]"),
    );
  });

  it("honors a code-selection-drop: exactly that marker leaves the composition", async () => {
    const d = drive();
    await d.feedEvents([
      open(),
      seg(2, "compare these"),
      { at: 3, type: "code-selection", marker: "code_1", text: "const a = 1;" },
      { at: 4, type: "code-selection", marker: "code_2", text: "const b = 2;" },
      { at: 5, type: "code-selection-drop", marker: "code_1" },
    ]);
    await d.fin();
    expect(d.sent[0].text).toBe(
      spoken("compare these [code selection at MISSING_LOCATION: `const b = 2;`]"),
    );
  });

  it("records first-class trace stages for both selection kinds and both drops", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-sel-"));
    const d = drive({ cache });
    await d.feedEvents([
      open(),
      {
        at: 2,
        type: "app-selection",
        marker: "sel_1",
        text: "the histogram title",
        cell: "hist",
      },
      seg(3, "make it bigger"),
      {
        at: 4,
        type: "code-selection",
        marker: "code_1",
        text: "const s = 1;",
        sourceLoc: "src/s.ts:1:1",
      },
      { at: 5, type: "code-selection-drop", marker: "code_1" },
      { at: 6, type: "app-selection-drop", marker: "sel_1" },
    ]);
    await d.fin();
    const [trace] = listTraces(cache);
    const appStage = trace.stages.find((s) => s.label === "app selection");
    expect(appStage?.data).toMatchObject({
      marker: "sel_1",
      text: "the histogram title",
      cell: "hist",
    });
    const codeStage = trace.stages.find((s) => s.label === "code selection");
    expect(codeStage?.data).toMatchObject({
      marker: "code_1",
      text: "const s = 1;",
      sourceLoc: "src/s.ts:1:1",
    });
    const codeDrop = trace.stages.find((s) => s.label === "code selection dropped");
    expect(codeDrop?.data).toMatchObject({ marker: "code_1" });
    const appDrop = trace.stages.find((s) => s.label === "app selection dropped");
    expect(appDrop?.data).toMatchObject({ marker: "sel_1" });
  });
});
