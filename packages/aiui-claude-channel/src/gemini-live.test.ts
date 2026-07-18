import { describe, expect, it } from "vitest";
import { type FakeUpstream, fakeUpstream } from "./fake-upstream";
import { openGeminiLiveSession, parseTimeLeftMs, WindowOrderingGuard } from "./gemini-live";
import { LINTER_INSTRUCTIONS, type LiveSessionCallbacks } from "./live-session";

function collect(up: FakeUpstream) {
  const replyTranscripts: string[] = [];
  const replyAudio: Array<{ bytes: Uint8Array; mime: string }> = [];
  const usages: Array<{ provider: string; model: string }> = [];
  const errors: string[] = [];
  const goAways: number[] = [];
  let interrupted = 0;
  const cb: LiveSessionCallbacks = {
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
  it("configures manual VAD, read_file, NO input transcription, and compression on open", () => {
    const up = fakeUpstream();
    collect(up);
    up.open();
    expect(up.sent).toHaveLength(1);
    expect(up.sent[0]).toMatchObject({
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: { responseModalities: ["AUDIO"] },
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        outputAudioTranscription: {},
        sessionResumption: {},
        contextWindowCompression: { slidingWindow: {} },
      },
    });
    const setup = (
      up.sent[0] as {
        setup: {
          inputAudioTranscription?: object;
          systemInstruction: { parts: Array<{ text: string }> };
          tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
        };
      }
    ).setup;
    // The STT session owns the chronicle — no vendor input transcription.
    expect(setup.inputAudioTranscription).toBeUndefined();
    expect(setup.systemInstruction.parts[0].text).toBe(LINTER_INSTRUCTIONS);
    expect(setup.tools[0].functionDeclarations.map((d) => d.name)).toEqual(["read_file"]);
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

  it("accumulates the reply (transcript + audio) per turn and flushes at turnComplete", () => {
    const up = fakeUpstream();
    const { session, replyTranscripts, replyAudio } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    session.activityStart();
    session.appendAudio(new Uint8Array([1]));
    session.activityEnd();
    up.emit({ serverContent: { outputTranscription: { text: "clear " } } });
    up.emit({ serverContent: { outputTranscription: { text: "so far" } } });
    up.emit({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: Buffer.from([1, 2, 3, 4]).toString("base64") } }],
        },
      },
    });
    // Nothing flushed until turnComplete.
    expect(replyTranscripts).toEqual([]);
    up.emit({ serverContent: { turnComplete: true } });
    expect(replyTranscripts).toEqual(["clear so far"]);
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

  it("an upstream error is surfaced loudly (once)", () => {
    const up = fakeUpstream();
    const { session, errors } = collect(up);
    up.open();
    up.emit({ setupComplete: {} });
    up.error("connection reset");
    expect(errors).toEqual(["connection reset"]);
    expect(session).toBeTruthy();
  });
});

// ── linter mode (the prompt-linter pivot) ────────────────────────────────────

function collectLinter(up: FakeUpstream) {
  const toolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const replyTranscripts: string[] = [];
  let lastRespond: ((result: string) => void) | undefined;
  const cb: LiveSessionCallbacks = {
    onReplyTranscript: (text) => replyTranscripts.push(text),
    onReplyAudio: () => {},
    onInterrupted: () => {},
    onUsage: () => {},
    onError: () => {},
    onToolCall: (call) => {
      toolCalls.push({ tool: call.tool, args: call.args });
      lastRespond = call.respond;
    },
  };
  const session = openGeminiLiveSession(
    {
      apiKey: "k",
      model: () => "gemini-3.1-flash-live-preview",
      socketFactory: up.factory,
    },
    cb,
  );
  return { session, toolCalls, replyTranscripts, respond: (r: string) => lastRespond?.(r) };
}

describe("openGeminiLiveSession (linter mode)", () => {
  it("sets up read_file + the linter persona, and drops input transcription", () => {
    const up = fakeUpstream();
    collectLinter(up);
    up.open();
    const setup = up.sent[0].setup as {
      systemInstruction: { parts: Array<{ text: string }> };
      tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
      inputAudioTranscription?: object;
      outputAudioTranscription?: object;
    };
    expect(setup.systemInstruction.parts[0].text).toBe(LINTER_INSTRUCTIONS);
    expect(setup.tools[0].functionDeclarations.map((d) => d.name)).toEqual(["read_file"]);
    // The STT session owns the chronicle — no vendor input transcription…
    expect(setup.inputAudioTranscription).toBeUndefined();
    // …but output transcription stays: the reply text IS the linter note.
    expect(setup.outputAudioTranscription).toEqual({});
  });

  it("routes a read_file call to onToolCall; respond writes a toolResponse with the result", () => {
    const up = fakeUpstream();
    const { toolCalls, respond } = collectLinter(up);
    up.open();
    up.emit({ setupComplete: {} });
    up.emit({
      toolCall: {
        functionCalls: [{ id: "fc1", name: "read_file", args: { path: "src/a.ts" } }],
      },
    });
    expect(toolCalls).toEqual([{ tool: "read_file", args: { path: "src/a.ts" } }]);

    respond("const a = 1;");
    // Gemini resumes on its own after the toolResponse — exactly one frame.
    expect(up.sent.at(-1)).toEqual({
      toolResponse: {
        functionResponses: [{ id: "fc1", name: "read_file", response: { result: "const a = 1;" } }],
      },
    });
  });

  it("cancelActiveResponse is a safe no-op (no client-side cancel on this wire)", () => {
    const up = fakeUpstream();
    const { session } = collectLinter(up);
    up.open();
    up.emit({ setupComplete: {} });
    const before = up.sent.length;
    session.cancelActiveResponse();
    expect(up.sent.length).toBe(before);
  });
});
