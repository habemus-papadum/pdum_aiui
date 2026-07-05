import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IntentEvent } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { describe, expect, it } from "vitest";
import type { ChannelFormat, ThreadContext } from "./channel";
import { type Corrector, mockCorrector } from "./correct";
import type { ChunkDescriptor, HelloMeta } from "./frame";
import { createIntentV1Format } from "./intent-v1";
import { defaultFormats } from "./processors";
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
  isClosed(): boolean;
}

interface DriveOptions {
  hello?: HelloMeta;
  transcriber?: Transcriber;
  corrector?: Corrector;
  /** When set, wrap the format in tracing rooted here so blob paths resolve. */
  cache?: string;
}

/** Drive an intent-v1 processor directly, as the channel connection would. */
function drive(opts: DriveOptions = {}): Driver {
  const sent: SentPrompt[] = [];
  const pushed: unknown[] = [];
  let closed = false;
  const ctx: ThreadContext = {
    threadId: "t-1",
    ...(opts.hello !== undefined ? { hello: opts.hello } : {}),
    sendPrompt: (text, meta) => {
      sent.push({ text, ...(meta !== undefined ? { meta } : {}) });
    },
    push: (message) => {
      pushed.push(message);
    },
    close: () => {
      closed = true;
    },
  };

  let format: ChannelFormat = createIntentV1Format({
    ...(opts.transcriber !== undefined ? { transcriber: opts.transcriber } : {}),
    ...(opts.corrector !== undefined ? { corrector: opts.corrector } : {}),
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

  it("ink-and-region-shot: a shot with no attachment degrades to an inline bracket", async () => {
    const d = drive();
    await d.feedEvents(loadFixture("ink-and-region-shot.json"));
    await d.fin();
    expect(d.sent).toHaveLength(1);
    // No pixels were captured → Option-A inline marker, nothing in meta.
    expect(d.sent[0].text).toContain("[shot_1");
    expect(d.sent[0].meta).toBeUndefined();
  });

  it("full-turn-send: a shot attachment becomes an Option-C token + absolute meta path", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-intent-"));
    const d = drive({ cache });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    await d.feedEvents(loadFixture("full-turn-send.json"));
    await d.feedAttachment("shot_1", "image/png", png);
    await d.fin();

    expect(d.sent).toHaveLength(1);
    const { text, meta } = d.sent[0];
    // Both dictated segments survive, with the token positioned between them.
    expect(text).toContain("make the baseline curve");
    expect(text).toContain("the legend overlaps the plot");
    expect(text).toContain("{shot_1}");
    // The path rides meta, is absolute, and the blob was actually written.
    expect(meta?.shot_1).toBeDefined();
    expect(isAbsolute(meta?.shot_1 ?? "")).toBe(true);
    expect(existsSync(meta?.shot_1 ?? "")).toBe(true);
    expect([...readFileSync(meta?.shot_1 ?? "")]).toEqual([...png]);

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

    expect(d.pushed).toHaveLength(1);
    const event = (d.pushed[0] as { events: IntentEvent[] }).events[0] as Extract<
      IntentEvent,
      { type: "correction" }
    >;
    expect(event.patch).toBeUndefined();

    // Falls back to plain first-occurrence replacement — the correction still lands.
    await d.fin();
    expect(d.sent[0].text).toContain("baseline");
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
    // No server-produced events (the client's patch was used as-is).
    expect(d.pushed).toEqual([]);
    expect(d.sent[0].text).toContain("baseline");
  });
});

describe("intent-v1 malformed input", () => {
  it("rejects an events chunk that is not a JSON events batch", async () => {
    const d = drive();
    await expect(d.feedEvents(undefined as unknown as IntentEvent[])).rejects.toThrow(/events/);
  });
});
