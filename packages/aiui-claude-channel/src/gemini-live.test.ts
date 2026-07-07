import { describe, expect, it } from "vitest";
import { openGeminiLiveSession, parseTimeLeftMs, WindowOrderingGuard } from "./gemini-live";
import {
  LIVE_COMPOSER_INSTRUCTIONS,
  LIVE_NUDGE_TEXT,
  type LiveSessionCallbacks,
} from "./live-session";
import type { RealtimeSocketFactory, RealtimeSocketHandlers } from "./realtime";

/** A scripted fake of the Gemini Live upstream (mirrors realtime.test.ts). */
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

function collect(up: FakeUpstream) {
  const userTranscripts: string[] = [];
  const replyTranscripts: string[] = [];
  const replyAudio: Array<{ bytes: Uint8Array; mime: string }> = [];
  const usages: Array<{ provider: string; model: string }> = [];
  const errors: string[] = [];
  const goAways: number[] = [];
  let interrupted = 0;
  const cb: LiveSessionCallbacks = {
    onUserTranscript: (text) => userTranscripts.push(text),
    onReplyTranscript: (text) => replyTranscripts.push(text),
    onReplyAudio: (bytes, mime) => replyAudio.push({ bytes, mime }),
    onInterrupted: () => {
      interrupted += 1;
    },
    onUsage: (cost) => usages.push({ provider: cost.provider, model: cost.model }),
    onError: (message) => errors.push(message),
    onGoAway: (msLeft) => goAways.push(msLeft),
  };
  const session = openGeminiLiveSession(
    { apiKey: "k", model: () => "gemini-3.1-flash-live-preview", socketFactory: up.factory },
    cb,
  );
  return {
    session,
    userTranscripts,
    replyTranscripts,
    replyAudio,
    usages,
    errors,
    goAways,
    get interrupted() {
      return interrupted;
    },
  };
}

const realtimeFrames = (up: FakeUpstream): Array<Record<string, unknown>> =>
  up.sent
    .map((m) => (m as { realtimeInput?: Record<string, unknown> }).realtimeInput)
    .filter((r): r is Record<string, unknown> => r !== undefined);

// ── the pure window-ordering guard ───────────────────────────────────────────

describe("WindowOrderingGuard", () => {
  it("queues non-audio frames in an audio-less window, flushes them on first audio", () => {
    const g = new WindowOrderingGuard<string>();
    expect(g.admit("activityStart", "start")).toEqual(["start"]);
    // A label + video before any audio → queued (nothing to send yet).
    expect(g.admit("other", "label")).toEqual([]);
    expect(g.admit("other", "video")).toEqual([]);
    // First audio flushes the queue, in order, after the audio.
    expect(g.admit("audio", "a1")).toEqual(["a1", "label", "video"]);
    // Subsequent audio and other frames pass straight through (window has audio).
    expect(g.admit("audio", "a2")).toEqual(["a2"]);
    expect(g.admit("other", "mid")).toEqual(["mid"]);
    expect(g.admit("activityEnd", "end")).toEqual(["end"]);
  });

  it("passes other frames straight through outside any window", () => {
    const g = new WindowOrderingGuard<string>();
    expect(g.admit("other", "text")).toEqual(["text"]);
  });

  it("flushes a window that closed before any audio out-of-window (after end)", () => {
    const g = new WindowOrderingGuard<string>();
    g.admit("activityStart", "start");
    g.admit("other", "label");
    expect(g.admit("activityEnd", "end")).toEqual(["end", "label"]);
  });
});

describe("parseTimeLeftMs", () => {
  it("parses a duration string, a {seconds,nanos} object, and garbage", () => {
    expect(parseTimeLeftMs("5s")).toBe(5000);
    expect(parseTimeLeftMs("0.5s")).toBe(500);
    expect(parseTimeLeftMs({ seconds: 3, nanos: 500_000_000 })).toBe(3500);
    expect(parseTimeLeftMs(undefined)).toBe(0);
    expect(parseTimeLeftMs("nope")).toBe(0);
  });
});

// ── the engine over the scripted fake ────────────────────────────────────────

describe("openGeminiLiveSession", () => {
  it("configures manual VAD, transcription, submit_intent, and compression on open", () => {
    const up = fakeUpstream();
    collect(up);
    up.open();
    expect(up.sent).toHaveLength(1);
    expect(up.sent[0]).toMatchObject({
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: { responseModalities: ["AUDIO"] },
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: {},
        contextWindowCompression: { slidingWindow: {} },
      },
    });
    const tools = (
      up.sent[0] as {
        setup: {
          tools: Array<{
            functionDeclarations: Array<{
              name: string;
              parameters: {
                properties: { segments: { items: { properties: Record<string, unknown> } } };
              };
            }>;
          }>;
        };
      }
    ).setup.tools;
    expect(tools[0].functionDeclarations[0].name).toBe("submit_intent");
    // Segments may interleave text, image ids, AND selection ids (F2).
    expect(
      Object.keys(tools[0].functionDeclarations[0].parameters.properties.segments.items.properties),
    ).toEqual(["text", "image", "selection"]);
  });

  it("sends the shared composer persona as the system instruction", () => {
    const up = fakeUpstream();
    collect(up);
    up.open();
    const setup = (
      up.sent[0] as { setup: { systemInstruction: { parts: Array<{ text: string }> } } }
    ).setup;
    expect(setup.systemInstruction.parts[0].text).toBe(LIVE_COMPOSER_INSTRUCTIONS);
  });

  it("nudgeSubmit sends the commit sentinel as a bare out-of-window text turn", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    session.nudgeSubmit();
    expect(realtimeFrames(up).some((r) => r.text === LIVE_NUDGE_TEXT)).toBe(true);
  });

  it("obeys the window rule: a label injected before audio is flushed after the first audio", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    session.activityStart();
    session.injectLabeledImage("shot_1", new Uint8Array([1, 2, 3]), "image/png");
    // No audio yet → the label + frame are queued, not on the wire.
    expect(realtimeFrames(up).some((r) => r.text === "[image shot_1]")).toBe(false);
    session.appendAudio(new Uint8Array([9, 9]));
    // First audio flushed the queue: audio, then the label text, then the frame.
    const frames = realtimeFrames(up);
    const audioIdx = frames.findIndex((r) => r.audio !== undefined);
    const labelIdx = frames.findIndex((r) => r.text === "[image shot_1]");
    const videoIdx = frames.findIndex((r) => r.video !== undefined);
    expect(audioIdx).toBeGreaterThanOrEqual(0);
    expect(audioIdx).toBeLessThan(labelIdx);
    expect(labelIdx).toBeLessThan(videoIdx);
  });

  it("injectContextText adds SILENT context: clientContent with turnComplete false, never realtimeInput", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    const label = '[selection sel_1: "gradient stops" — on-screen selection]';
    session.injectContextText(label);
    // The documented no-reply context append — a bare realtimeInput.text would
    // be answered immediately under manual VAD (spike finding 4).
    const frame = up.sent.find(
      (m) => (m as { clientContent?: unknown }).clientContent !== undefined,
    ) as {
      clientContent: {
        turns: Array<{ role: string; parts: Array<{ text: string }> }>;
        turnComplete: boolean;
      };
    };
    expect(frame).toBeDefined();
    expect(frame.clientContent.turnComplete).toBe(false);
    expect(frame.clientContent.turns[0].role).toBe("user");
    expect(frame.clientContent.turns[0].parts[0].text).toBe(label);
    expect(realtimeFrames(up).some((r) => r.text === label)).toBe(false);
  });

  it("injectContextText obeys the window rule (queued in an audio-less window, flushed on audio)", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    session.activityStart();
    session.injectContextText("[selection sel_1 retracted — disregard it]");
    expect(
      up.sent.some((m) => (m as { clientContent?: unknown }).clientContent !== undefined),
    ).toBe(false);
    session.appendAudio(new Uint8Array([1, 2]));
    expect(
      up.sent.some((m) => (m as { clientContent?: unknown }).clientContent !== undefined),
    ).toBe(true);
  });

  it("declares 24 kHz input audio (the client rate; Gemini resamples)", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    session.activityStart();
    session.appendAudio(new Uint8Array([1, 2]));
    const audio = realtimeFrames(up).find((r) => r.audio !== undefined)?.audio as {
      mimeType: string;
    };
    expect(audio.mimeType).toBe("audio/pcm;rate=24000");
  });

  it("delivers a submit_intent tool call through drainToolCall; respond sends toolResponse", async () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    up.emit({
      toolCall: {
        functionCalls: [
          {
            id: "fc1",
            name: "submit_intent",
            args: { segments: [{ text: "wider" }, { image: "shot_1" }, { selection: "sel_1" }] },
          },
        ],
      },
    });
    const call = await session.drainToolCall(1000);
    expect(call).not.toBeNull();
    expect(call?.segments).toEqual([
      { text: "wider" },
      { image: "shot_1" },
      { selection: "sel_1" },
    ]);
    call?.respond(true);
    expect(up.sent).toContainEqual({
      toolResponse: {
        functionResponses: [{ id: "fc1", name: "submit_intent", response: { ok: true } }],
      },
    });
  });

  it("buffers a tool call that arrives before the drain is awaited", async () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    up.emit({
      toolCall: { functionCalls: [{ id: "fc1", name: "submit_intent", args: { segments: [] } }] },
    });
    await expect(session.drainToolCall(1000)).resolves.not.toBeNull();
  });

  it("drainToolCall resolves null on timeout", async () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    await expect(session.drainToolCall(0)).resolves.toBeNull();
  });

  it("accumulates transcripts + audio per turn and flushes them at turnComplete", () => {
    const up = fakeUpstream();
    const { session, userTranscripts, replyTranscripts, replyAudio } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    session.activityStart();
    session.appendAudio(new Uint8Array([1]));
    session.activityEnd();
    up.emit({ serverContent: { inputTranscription: { text: "make it " } } });
    up.emit({ serverContent: { inputTranscription: { text: "wider" } } });
    up.emit({ serverContent: { outputTranscription: { text: "on it" } } });
    up.emit({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: Buffer.from([1, 2, 3, 4]).toString("base64") } }],
        },
      },
    });
    // Nothing flushed until turnComplete.
    expect(userTranscripts).toEqual([]);
    up.emit({ serverContent: { turnComplete: true } });
    expect(userTranscripts).toEqual(["make it wider"]);
    expect(replyTranscripts).toEqual(["on it"]);
    expect(replyAudio).toHaveLength(1);
    expect(replyAudio[0].mime).toBe("audio/wav");
    expect(String.fromCharCode(...replyAudio[0].bytes.subarray(0, 4))).toBe("RIFF");
  });

  it("drops the half-spoken reply on interrupted (barge-in)", () => {
    const up = fakeUpstream();
    const { session, replyAudio } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    up.emit({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: Buffer.from([7, 7]).toString("base64") } }] },
      },
    });
    up.emit({ serverContent: { interrupted: true } });
    up.emit({ serverContent: { turnComplete: true } });
    expect(replyAudio).toEqual([]);
    expect(session).toBeTruthy();
  });

  it("prices usageMetadata against the google provider", () => {
    const up = fakeUpstream();
    const { usages } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    up.emit({
      usageMetadata: {
        totalTokenCount: 100,
        promptTokenCount: 60,
        responseTokenCount: 40,
        promptTokensDetails: [{ modality: "AUDIO", tokenCount: 50 }],
        responseTokensDetails: [{ modality: "AUDIO", tokenCount: 30 }],
      },
    });
    expect(usages).toHaveLength(1);
    expect(usages[0].provider).toBe("google");
  });

  it("surfaces GoAway as milliseconds remaining", () => {
    const up = fakeUpstream();
    const { goAways } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    up.emit({ goAway: { timeLeft: "9s" } });
    expect(goAways).toEqual([9000]);
  });

  it("an upstream error is surfaced and drain then resolves null", async () => {
    const up = fakeUpstream();
    const { session, errors } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    up.error("connection reset");
    expect(errors).toEqual(["connection reset"]);
    await expect(session.drainToolCall(1000)).resolves.toBeNull();
  });
});
