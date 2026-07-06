import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntentEvent } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { describe, expect, it } from "vitest";
import type { ChannelFormat, MessageMeta, StreamProcessor, ThreadContext } from "./channel";
import type { ChunkDescriptor, HelloMeta } from "./frame";
import { createIntentV1Format, type LoweredMessage } from "./intent-v1";
import type { RealtimeSocketFactory, RealtimeSocketHandlers } from "./realtime";
import { createTraceStore } from "./trace";

/** A scripted fake of the Gemini Live upstream. */
interface FakeUpstream {
  factory: RealtimeSocketFactory;
  sent: Array<Record<string, unknown>>;
  closed: boolean;
  open(): void;
  emit(message: Record<string, unknown>): void;
  error(message: string): void;
}

function fakeUpstream(): FakeUpstream {
  let handlers: RealtimeSocketHandlers | undefined;
  const up: FakeUpstream = {
    sent: [],
    closed: false,
    factory: (_url, _apiKey, h) => {
      handlers = h;
      return {
        send: (text) => up.sent.push(JSON.parse(text)),
        close: () => {
          up.closed = true;
          handlers?.onClose();
        },
      };
    },
    open: () => handlers?.onOpen(),
    emit: (message) => handlers?.onMessage(JSON.stringify(message)),
    error: (message) => handlers?.onError(message),
  };
  return up;
}

const enc = new TextEncoder();

interface Driver {
  feedEvents(events: IntentEvent[], fin?: boolean): Promise<void>;
  feedAudio(id: string, seq: number, bytes: Uint8Array): Promise<void>;
  feedShot(id: string, bytes: Uint8Array): Promise<void>;
  feedVideo(id: string, seq: number, bytes: Uint8Array): Promise<void>;
  fin(): Promise<void>;
  close(): Promise<void> | void;
  sent: Array<{ text: string }>;
  pushed: unknown[];
}

interface DriveOptions {
  factory?: RealtimeSocketFactory;
  apiKey?: string;
  hello?: HelloMeta;
  withTrace?: boolean;
}

function drive(opts: DriveOptions): Driver {
  const sent: Driver["sent"] = [];
  const pushed: unknown[] = [];
  const trace = opts.withTrace
    ? createTraceStore(mkdtempSync(join(tmpdir(), "aiui-live-"))).begin("intent-v1", "t-live")
    : undefined;
  const ctx: ThreadContext & {
    trace?: ReturnType<typeof createTraceStore>["begin"] extends never ? never : unknown;
  } = {
    threadId: "t-live",
    hello: opts.hello ?? { intent: { tier: "live-gemini" } },
    sendPrompt: (text) => sent.push({ text }),
    push: (message) => pushed.push(message),
    close: () => {},
    ...(trace !== undefined ? { trace } : {}),
  };
  const format: ChannelFormat = createIntentV1Format({
    ...(opts.factory !== undefined ? { geminiLiveSocketFactory: opts.factory } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  });
  const processor: StreamProcessor = format.createProcessor(ctx);
  const send = (payload: Uint8Array, chunk: ChunkDescriptor | undefined, fin: boolean) =>
    processor.onMessage(payload, { fin, ...(chunk !== undefined ? { chunk } : {}) } as MessageMeta);
  return {
    feedEvents: (events, fin = false) =>
      send(enc.encode(JSON.stringify({ events })), { kind: "events" }, fin),
    feedAudio: (id, seq, bytes) =>
      send(bytes, { kind: "audio", id, seq, mime: "audio/pcm;rate=24000" }, false),
    feedShot: (id, bytes) => send(bytes, { kind: "attachment", id, mime: "image/png" }, false),
    feedVideo: (id, seq, bytes) =>
      send(bytes, { kind: "video", id, seq, mime: "image/jpeg" }, false),
    fin: () => send(new Uint8Array(0), undefined, true),
    close: () => processor.onClose?.(),
    sent,
    pushed,
  };
}

const notesOf = (pushed: unknown[]): IntentEvent[] =>
  pushed.flatMap((m) => ((m as LoweredMessage).events ?? []).filter((e) => e.type === "note"));
const finalsOf = (pushed: unknown[]): IntentEvent[] =>
  pushed.flatMap((m) =>
    ((m as LoweredMessage).events ?? []).filter((e) => e.type === "transcript-final"),
  );

describe("intent-v1 realtime submode (gemini)", () => {
  it("model composes: a submit_intent tool call becomes the lowered prompt, shot refs resolved", async () => {
    const up = fakeUpstream();
    const d = drive({ factory: up.factory, apiKey: "k", withTrace: true });
    up.open();
    up.emit({ setupComplete: {} });

    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
    ]);
    await d.feedAudio("seg_1", 0, new Uint8Array([1, 2]));
    await d.feedEvents([{ at: 3, type: "talk-end", segment: 1, ms: 300 }]);
    // The shot event (metadata) + its bytes.
    await d.feedEvents([
      { at: 4, type: "shot", marker: "shot_1", rect: { x: 0, y: 0, w: 4, h: 4 }, components: [] },
    ]);
    await d.feedShot("shot_1", new Uint8Array([137, 80, 78, 71]));
    // The label was injected upstream (text then frame).
    expect(
      up.sent.some(
        (m) =>
          (m as { realtimeInput?: { text?: string } }).realtimeInput?.text === "[image shot_1]",
      ),
    ).toBe(true);

    // The user transcript arrives and merges as a synthetic transcript-final.
    up.emit({ serverContent: { inputTranscription: { text: "make the panel wider" } } });
    up.emit({ serverContent: { turnComplete: true } });
    expect(finalsOf(d.pushed).map((f) => (f as { text: string }).text)).toEqual([
      "make the panel wider",
    ]);

    // fin nudges; the model answers with submit_intent while the drain is pending.
    const finished = d.fin();
    up.emit({
      toolCall: {
        functionCalls: [
          {
            id: "fc1",
            name: "submit_intent",
            args: {
              segments: [{ text: "make the panel" }, { image: "shot_1" }, { text: "much wider" }],
            },
          },
        ],
      },
    });
    await finished;

    expect(d.sent).toHaveLength(1);
    const prompt = d.sent[0].text;
    expect(prompt).toContain("make the panel");
    expect(prompt).toContain("much wider");
    expect(prompt).toContain("<screenshot");
    expect(prompt).toContain("shot_1.png");
    // The tool response acknowledged the call.
    expect(up.sent.some((m) => (m as { toolResponse?: unknown }).toolResponse !== undefined)).toBe(
      true,
    );
    expect(up.closed).toBe(true);
  });

  it("falls back to composeIntent over the chronicle when no tool call arrives", async () => {
    const up = fakeUpstream();
    const d = drive({ factory: up.factory, apiKey: "k" });
    up.open();
    up.emit({ setupComplete: {} });

    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
    ]);
    await d.feedAudio("seg_1", 0, new Uint8Array([1, 2]));
    await d.feedEvents([{ at: 3, type: "talk-end", segment: 1, ms: 200 }]);
    up.emit({ serverContent: { inputTranscription: { text: "make it wider" } } });
    up.emit({ serverContent: { turnComplete: true } });

    // fin: the model never calls submit_intent; the session dies (a step-3
    // fallback trigger) so the drain resolves null and composeIntent takes over.
    const finished = d.fin();
    up.error("connection reset");
    await finished;

    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].text).toBe("make it wider");
    // The fallback is loud (an error push explaining the model didn't compose).
    expect(
      d.pushed.some(
        (m) =>
          (m as { kind?: string }).kind === "error" &&
          /didn't compose/.test((m as { message: string }).message),
      ),
    ).toBe(true);
  });

  it("a cancelled turn lowers to nothing and closes the session", async () => {
    const up = fakeUpstream();
    const d = drive({ factory: up.factory, apiKey: "k" });
    up.open();
    up.emit({ setupComplete: {} });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "thread-close", reason: "cancel" },
    ]);
    await d.fin();
    expect(d.sent).toEqual([]);
    expect(up.closed).toBe(true);
  });

  it("keyless realtime degrades LOUDLY at open (no silent downgrade) and sends nothing", async () => {
    const d = drive({ apiKey: "", hello: { intent: { tier: "live-gemini" } } });
    await d.feedEvents([{ at: 1, type: "thread-open", trigger: "talk" }]);
    const errored = d.pushed.some(
      (m) =>
        (m as { kind?: string }).kind === "error" &&
        /GEMINI_API_KEY/.test((m as { message: string }).message),
    );
    expect(errored).toBe(true);
    await d.fin();
    expect(d.sent).toEqual([]);
  });

  it("streams ambient video into the live session (gemini has video)", async () => {
    const up = fakeUpstream();
    const d = drive({ factory: up.factory, apiKey: "k" });
    up.open();
    up.emit({ setupComplete: {} });
    await d.feedEvents([{ at: 1, type: "thread-open", trigger: "talk" }]);
    await d.feedEvents([{ at: 2, type: "video-share", on: true }]);
    // A frame outside any talk window is safe (goes straight through).
    await d.feedVideo("vid_1", 0, new Uint8Array([255, 216, 255]));
    expect(
      up.sent.some(
        (m) => (m as { realtimeInput?: { video?: unknown } }).realtimeInput?.video !== undefined,
      ),
    ).toBe(true);
  });

  it("ignores corrections in realtime mode with a patchless echo + a note", async () => {
    const up = fakeUpstream();
    const d = drive({ factory: up.factory, apiKey: "k" });
    up.open();
    up.emit({ setupComplete: {} });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      {
        at: 2,
        type: "correction",
        from: 0,
        to: 4,
        original: "wide",
        instruction: "wider",
        via: "typed",
        patch: "@@ -1 +1 @@\n-wide\n+wider\n",
      },
    ]);
    // The correction is echoed without its patch (never run) and a note explains.
    const echoed = d.pushed
      .flatMap((m) => (m as LoweredMessage).events ?? [])
      .filter((e) => e.type === "correction");
    expect(echoed).toHaveLength(1);
    expect((echoed[0] as { patch?: string }).patch).toBeUndefined();
    expect(
      notesOf(d.pushed).some((n) =>
        /corrections are off in realtime/.test((n as { text: string }).text),
      ),
    ).toBe(true);
  });
});
