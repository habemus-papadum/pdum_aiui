import { describe, expect, it } from "vitest";
import type { LiveSessionCallbacks } from "./live-session";
import { openOpenAiLiveSession } from "./openai-live";
import type { RealtimeSocketFactory, RealtimeSocketHandlers } from "./realtime";

/** A scripted fake of the OpenAI realtime upstream (mirrors realtime-voice.test.ts). */
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

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString("base64");

function collect(up: FakeUpstream) {
  const userTranscripts: string[] = [];
  const replyTranscripts: string[] = [];
  const replyAudio: Array<{ mime: string }> = [];
  const usages: Array<{ provider: string }> = [];
  const errors: string[] = [];
  const cb: LiveSessionCallbacks = {
    onUserTranscript: (text) => userTranscripts.push(text),
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
  return { session, userTranscripts, replyTranscripts, replyAudio, usages, errors };
}

const types = (up: FakeUpstream): string[] => up.sent.map((m) => m.type as string);

describe("openOpenAiLiveSession", () => {
  it("configures a realtime session with manual VAD, input transcription, and submit_intent", () => {
    const up = fakeUpstream();
    collect(up);
    up.open();
    expect(up.sent[0]).toMatchObject({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime-2",
        output_modalities: ["audio"],
        audio: {
          input: { turn_detection: null, transcription: { model: "gpt-4o-mini-transcribe" } },
        },
      },
    });
    const tools = (up.sent[0] as { session: { tools: Array<{ name: string }> } }).session.tools;
    expect(tools[0].name).toBe("submit_intent");
  });

  it("has no video and no-ops appendVideoFrame", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    expect(session.capabilities.video).toBe(false);
    expect(session.capabilities.imageInjection).toBe("turn-item");
    const before = up.sent.length;
    session.appendVideoFrame(new Uint8Array([1, 2, 3]), "image/jpeg");
    expect(up.sent.length).toBe(before);
  });

  it("activityEnd commits the buffer and asks for a response", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.activityStart();
    session.appendAudio(new Uint8Array([1, 2]));
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

  it("nudgeSubmit posts a text item and a response.create", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.nudgeSubmit();
    expect(types(up)).toContain("conversation.item.create");
    expect(types(up)).toContain("response.create");
  });

  it("delivers a function_call from response.done through drainToolCall; respond writes function_call_output", async () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    up.emit({
      type: "response.done",
      response: {
        id: "resp_1",
        output: [
          {
            type: "function_call",
            name: "submit_intent",
            call_id: "call_1",
            arguments: JSON.stringify({ segments: [{ text: "wider" }, { image: "shot_1" }] }),
          },
        ],
      },
    });
    const call = await session.drainToolCall(1000);
    expect(call?.segments).toEqual([{ text: "wider" }, { image: "shot_1" }]);
    call?.respond(true);
    const out = up.sent.find(
      (m) =>
        m.type === "conversation.item.create" &&
        (m as { item?: { type?: string } }).item?.type === "function_call_output",
    ) as { item: { call_id: string; output: string } };
    expect(out.item.call_id).toBe("call_1");
    expect(JSON.parse(out.item.output)).toEqual({ ok: true });
  });

  it("surfaces the user transcript, reply audio, reply transcript, and usage", () => {
    const up = fakeUpstream();
    const { userTranscripts, replyTranscripts, replyAudio, usages } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    up.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "make it wider",
    });
    up.emit({
      type: "response.output_audio.delta",
      response_id: "resp_1",
      delta: b64([1, 2, 3, 4]),
    });
    up.emit({
      type: "response.output_audio_transcript.done",
      response_id: "resp_1",
      transcript: "on it",
    });
    up.emit({
      type: "response.done",
      response: {
        id: "resp_1",
        usage: { input_tokens: 100, output_tokens: 40, input_token_details: { audio_tokens: 50 } },
      },
    });
    expect(userTranscripts).toEqual(["make it wider"]);
    expect(replyAudio).toEqual([{ mime: "audio/wav" }]);
    expect(replyTranscripts).toEqual(["on it"]);
    expect(usages).toEqual([{ provider: "openai" }]);
  });

  it("an upstream error is surfaced and drain resolves null", async () => {
    const up = fakeUpstream();
    const { session, errors } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    up.error("connection reset");
    expect(errors).toEqual(["connection reset"]);
    await expect(session.drainToolCall(1000)).resolves.toBeNull();
  });
});
