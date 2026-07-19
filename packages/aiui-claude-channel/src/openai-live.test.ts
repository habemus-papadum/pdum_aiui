import { describe, expect, it } from "vitest";
import { type FakeUpstream, fakeUpstream } from "./fake-upstream";
import { LINTER_INSTRUCTIONS, type LiveSessionCallbacks } from "./live-session";
import { openOpenAiLiveSession } from "./openai-live";

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString("base64");

function collect(up: FakeUpstream) {
  const replyTranscripts: string[] = [];
  const replyAudio: Array<{ mime: string }> = [];
  const usages: Array<{ provider: string }> = [];
  const errors: string[] = [];
  const cb: LiveSessionCallbacks = {
    onReplyTranscript: (text) => replyTranscripts.push(text),
    onReplyAudio: (_bytes, mime) => replyAudio.push({ mime }),
    onInterrupted: () => {},
    onUsage: (cost) => usages.push({ provider: cost.provider }),
    onError: (message) => errors.push(message),
  };
  const session = openOpenAiLiveSession(
    { apiKey: "k", model: () => "gpt-realtime-2", socketFactory: up.factory },
    cb,
  );
  return { session, replyTranscripts, replyAudio, usages, errors };
}

const types = (up: FakeUpstream): string[] => up.sent.map((m) => m.type as string);

describe("openOpenAiLiveSession", () => {
  it("configures a realtime session with manual VAD, read_file, and NO input transcription", () => {
    const up = fakeUpstream();
    collect(up);
    up.open();
    expect(up.sent[0]).toMatchObject({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime-2",
        output_modalities: ["audio"],
        audio: { input: { turn_detection: null } },
      },
    });
    const session = (
      up.sent[0] as {
        session: {
          instructions: string;
          tools: Array<{ name: string }>;
          audio: { input: Record<string, unknown> };
        };
      }
    ).session;
    // The STT session owns the chronicle — no vendor input transcription.
    expect(session.audio.input.transcription).toBeUndefined();
    expect(session.tools.map((t) => t.name)).toEqual(["read_file"]);
    // The persona is the shared authoritative text (one place, both vendors).
    expect(session.instructions).toBe(LINTER_INSTRUCTIONS);
  });

  it("activityEnd past the commit floor commits the buffer and asks for a response", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.activityStart();
    session.appendAudio(new Uint8Array(200 * 48)); // 200 ms — over the floor
    session.activityEnd();
    expect(types(up)).toContain("input_audio_buffer.append");
    expect(types(up)).toContain("input_audio_buffer.commit");
    expect(types(up)).toContain("response.create");
  });

  it("injects a labeled image as a turn-item with input_text + input_image (no response)", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    const before = up.sent.filter((m) => m.type === "response.create").length;
    session.injectLabeledImage("shot_1", new Uint8Array([1, 2, 3]), "image/png");
    const item = up.sent.find((m) => m.type === "conversation.item.create") as {
      item: { content: Array<{ type: string; text?: string; image_url?: string }> };
    };
    expect(item.item.content[0]).toEqual({ type: "input_text", text: "[image shot_1]" });
    expect(item.item.content[1].type).toBe("input_image");
    expect(item.item.content[1].image_url).toMatch(/^data:image\/png;base64,/);
    // An image item never auto-triggers a response.
    expect(up.sent.filter((m) => m.type === "response.create").length).toBe(before);
  });

  it("injectContextText posts a bare input_text item and NO response.create (silent context)", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    const before = up.sent.filter((m) => m.type === "response.create").length;
    const label = '[selection sel_1: "gradient stops" — on-screen selection]';
    session.injectContextText(label);
    const item = up.sent.find((m) => m.type === "conversation.item.create") as {
      item: { type: string; role: string; content: Array<{ type: string; text?: string }> };
    };
    expect(item.item.role).toBe("user");
    expect(item.item.content).toEqual([{ type: "input_text", text: label }]);
    // Items never auto-trigger a response, and we must not create one either.
    expect(up.sent.filter((m) => m.type === "response.create").length).toBe(before);
  });

  it("STREAMS reply audio per delta; the transcript and usage land at response.done", () => {
    const up = fakeUpstream();
    const { replyTranscripts, replyAudio, usages } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    up.emit({
      type: "response.output_audio.delta",
      response_id: "resp_1",
      delta: b64([1, 2, 3, 4]),
    });
    // The delta streamed IMMEDIATELY — raw PCM, no WAV, no response.done wait
    // (whole-clip buffering retired 2026-07-19).
    expect(replyAudio).toEqual([{ mime: "audio/pcm;rate=24000" }]);
    expect(replyTranscripts).toEqual([]);
    up.emit({
      type: "response.output_audio_transcript.done",
      response_id: "resp_1",
      transcript: "clear so far",
    });
    up.emit({
      type: "response.done",
      response: {
        id: "resp_1",
        usage: { input_tokens: 100, output_tokens: 40, input_token_details: { audio_tokens: 50 } },
      },
    });
    expect(replyTranscripts).toEqual(["clear so far"]);
    expect(usages).toEqual([{ provider: "openai" }]);
  });

  it("an upstream error is surfaced loudly (once)", () => {
    const up = fakeUpstream();
    const { session, errors } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
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
  const session = openOpenAiLiveSession(
    { apiKey: "k", model: () => "gpt-realtime-2", socketFactory: up.factory },
    cb,
  );
  return { session, toolCalls, replyTranscripts, respond: (r: string) => lastRespond?.(r) };
}

describe("openOpenAiLiveSession (linter mode)", () => {
  it("routes a read_file call to onToolCall; respond writes output THEN response.create", () => {
    const up = fakeUpstream();
    const { toolCalls, respond } = collectLinter(up);
    up.open();
    up.emit({ type: "session.updated" });
    up.emit({
      type: "response.done",
      response: {
        id: "r1",
        output: [
          {
            type: "function_call",
            name: "read_file",
            call_id: "c9",
            arguments: JSON.stringify({ path: "src/a.ts" }),
          },
        ],
      },
    });
    expect(toolCalls).toEqual([{ tool: "read_file", args: { path: "src/a.ts" } }]);

    respond("const a = 1;");
    // THE RESUME RULE, asserted as wire ORDER: the output item first, then a
    // fresh response.create — a written tool result never resumes on its own.
    const tail = up.sent.slice(-2);
    expect(tail[0]).toMatchObject({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "c9", output: "const a = 1;" },
    });
    expect(tail[1]).toEqual({ type: "response.create" });
  });

  it("clears (never commits) a window under the 100 ms floor; a real window commits", () => {
    const up = fakeUpstream();
    const { session } = collectLinter(up);
    up.open();
    up.emit({ type: "session.updated" });
    // A tap: 40 ms of audio (48 bytes/ms) — under the floor.
    session.activityStart();
    session.appendAudio(new Uint8Array(40 * 48));
    session.activityEnd();
    expect(types(up)).toContain("input_audio_buffer.clear");
    expect(types(up)).not.toContain("input_audio_buffer.commit");

    // A real window: 200 ms — commits and solicits the lint.
    session.appendAudio(new Uint8Array(200 * 48));
    session.activityEnd();
    expect(types(up)).toContain("input_audio_buffer.commit");
    expect(types(up).filter((t) => t === "response.create")).toHaveLength(1);
  });

  it("cancelActiveResponse sends response.cancel (client-side barge-in)", () => {
    const up = fakeUpstream();
    const { session } = collectLinter(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.cancelActiveResponse();
    expect(up.sent.at(-1)).toEqual({ type: "response.cancel" });
  });
});

// ── turn-complete: the converse after-reply signal ───────────────────────────

function collectTurns(up: FakeUpstream) {
  let turnsComplete = 0;
  let lastRespond: ((result: string) => void) | undefined;
  const cb: LiveSessionCallbacks = {
    onReplyTranscript: () => {},
    onReplyAudio: () => {},
    onInterrupted: () => {},
    onUsage: () => {},
    onError: () => {},
    onToolCall: (call) => {
      lastRespond = call.respond;
    },
    onTurnComplete: () => {
      turnsComplete += 1;
    },
  };
  openOpenAiLiveSession(
    { apiKey: "k", model: () => "gpt-realtime-2", socketFactory: up.factory },
    cb,
  );
  return { turns: () => turnsComplete, respond: (r: string) => lastRespond?.(r) };
}

describe("onTurnComplete (the converse after-reply signal)", () => {
  it("fires at response.done with no function_call in the output", () => {
    const up = fakeUpstream();
    const { turns } = collectTurns(up);
    up.open();
    up.emit({ type: "session.updated" });
    up.emit({ type: "response.done", response: { id: "r1" } });
    expect(turns()).toBe(1);
  });

  it("a tool-call turn is NOT complete — only the resumed response's done fires it", () => {
    const up = fakeUpstream();
    const { turns, respond } = collectTurns(up);
    up.open();
    up.emit({ type: "session.updated" });
    up.emit({
      type: "response.done",
      response: {
        id: "r1",
        output: [
          {
            type: "function_call",
            name: "read_file",
            call_id: "c1",
            arguments: JSON.stringify({ path: "src/a.ts" }),
          },
        ],
      },
    });
    expect(turns()).toBe(0); // the model is about to resume — floor not free
    respond("const a = 1;");
    up.emit({ type: "response.done", response: { id: "r2" } });
    expect(turns()).toBe(1);
  });
});

// ── oracle mode: server VAD + vendor input transcription ─────────────────────

describe("oracle mode (serverVad + inputTranscriptionModel)", () => {
  function openOracle(up: FakeUpstream) {
    const heard: string[] = [];
    const cb: LiveSessionCallbacks = {
      onReplyTranscript: () => {},
      onReplyAudio: () => {},
      onInterrupted: () => {},
      onUsage: () => {},
      onError: () => {},
      onInputTranscript: (text) => heard.push(text),
    };
    const session = openOpenAiLiveSession(
      {
        apiKey: "k",
        model: () => "gpt-realtime-2",
        serverVad: true,
        inputTranscriptionModel: "gpt-4o-mini-transcribe",
        instructions: "oracle persona",
        socketFactory: up.factory,
      },
      cb,
    );
    return { session, heard };
  }

  it("configures server_vad turn detection AND vendor input transcription", () => {
    const up = fakeUpstream();
    openOracle(up);
    up.open();
    expect(up.sent[0]).toMatchObject({
      type: "session.update",
      session: {
        instructions: "oracle persona",
        audio: {
          input: {
            turn_detection: { type: "server_vad" },
            transcription: { model: "gpt-4o-mini-transcribe" },
          },
        },
      },
    });
  });

  it("activityEnd never manual-commits under server VAD (the vendor owns the turn)", () => {
    const up = fakeUpstream();
    const { session } = openOracle(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.activityStart();
    session.appendAudio(new Uint8Array(200 * 48)); // well over the manual floor
    session.activityEnd();
    expect(types(up)).toContain("input_audio_buffer.append");
    expect(types(up)).not.toContain("input_audio_buffer.commit");
    expect(types(up)).not.toContain("input_audio_buffer.clear");
    expect(types(up)).not.toContain("response.create");
  });

  it("routes the vendor's input transcription to onInputTranscript", () => {
    const up = fakeUpstream();
    const { heard } = openOracle(up);
    up.open();
    up.emit({ type: "session.updated" });
    up.emit({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "what does the fold do",
    });
    up.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "" });
    expect(heard).toEqual(["what does the fold do"]); // empties dropped
  });
});

describe("benign cancel-miss (the sidecar barge-ins on every talk-start)", () => {
  it("swallows 'no active response' cancel errors instead of failing the session", () => {
    const up = fakeUpstream();
    const { session } = collectLinter(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.cancelActiveResponse();
    up.emit({
      type: "error",
      error: {
        code: "response_cancel_not_active",
        message: "Cancellation failed: no active response found",
      },
    });
    // The session is still alive and usable — no onError fired (collectLinter
    // has no error sink; a fail() would have marked the session dead and the
    // next send would be dropped).
    session.activityStart();
    session.appendAudio(new Uint8Array(200 * 48));
    session.activityEnd();
    expect(types(up)).toContain("input_audio_buffer.commit");
  });

  it("still surfaces real errors loudly", () => {
    const up = fakeUpstream();
    const errors: string[] = [];
    const cb: LiveSessionCallbacks = {
      onReplyTranscript: () => {},
      onReplyAudio: () => {},
      onInterrupted: () => {},
      onUsage: () => {},
      onError: (m) => errors.push(m),
    };
    openOpenAiLiveSession(
      { apiKey: "k", model: () => "gpt-realtime-2", socketFactory: up.factory },
      cb,
    );
    up.open();
    up.emit({ type: "session.updated" });
    up.emit({ type: "error", error: { code: "invalid_request_error", message: "bad session" } });
    expect(errors).toEqual(["bad session"]);
  });
});
