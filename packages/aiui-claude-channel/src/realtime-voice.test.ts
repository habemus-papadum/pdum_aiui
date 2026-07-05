import type { IntentEvent } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { describe, expect, it } from "vitest";
import type { ChannelFormat, MessageMeta, StreamProcessor, ThreadContext } from "./channel";
import type { ChunkDescriptor, HelloMeta } from "./frame";
import { createIntentV1Format, type SpeechMessage } from "./intent-v1";
import type { RealtimeSocketFactory, RealtimeSocketHandlers } from "./realtime";
import {
  openRealtimeVoiceSession,
  pcm16ToWav,
  type RealtimeVoiceCallbacks,
} from "./realtime-voice";

/** A scripted fake of the OpenAI realtime upstream (mirrors realtime.test.ts). */
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
const userDelta = (itemId: string, text: string) => ({
  type: "conversation.item.input_audio_transcription.delta",
  item_id: itemId,
  delta: text,
});
const userDone = (itemId: string, transcript: string) => ({
  type: "conversation.item.input_audio_transcription.completed",
  item_id: itemId,
  transcript,
});

// ── the voice session state machine, in isolation ────────────────────────────

describe("openRealtimeVoiceSession", () => {
  function collect(up: FakeUpstream, maxResponses?: number) {
    const userDeltas: Array<{ segment: number; text: string }> = [];
    const userFinals: Array<{ segment: number; text: string }> = [];
    const audio: Array<{ bytes: Uint8Array; mime: string; responseId: string }> = [];
    const replies: Array<{ text: string; responseId: string }> = [];
    const errors: Array<{ message: string; segment?: number }> = [];
    const cb: RealtimeVoiceCallbacks = {
      onUserDelta: (segment, text) => userDeltas.push({ segment, text }),
      onUserFinal: (segment, result) => userFinals.push({ segment, text: result.text }),
      onAudio: (clip) => audio.push(clip),
      onReplyTranscript: (text, responseId) => replies.push({ text, responseId }),
      onError: (message, segment) =>
        errors.push({ message, ...(segment !== undefined ? { segment } : {}) }),
    };
    const session = openRealtimeVoiceSession(
      {
        apiKey: "k",
        model: () => "gpt-realtime-2",
        voice: () => "cedar",
        socketFactory: up.factory,
        now: () => 0,
        ...(maxResponses !== undefined ? { maxResponses } : {}),
      },
      cb,
    );
    return { session, userDeltas, userFinals, audio, replies, errors };
  }

  it("configures a conversational session on open (audio out, input transcription, PTT)", () => {
    const up = fakeUpstream();
    collect(up);
    up.open();
    expect(up.sent).toHaveLength(1);
    expect(up.sent[0]).toMatchObject({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime-2",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: null,
          },
          output: { format: { type: "audio/pcm", rate: 24000 }, voice: "cedar" },
        },
        tools: [],
      },
    });
  });

  it("commit sends input_audio_buffer.commit AND response.create", () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.commit(1);
    const types = up.sent.map((m) => m.type);
    expect(types).toContain("input_audio_buffer.commit");
    expect(types).toContain("response.create");
  });

  it("input transcription feeds the IR: deltas accumulate, completed → onUserFinal", () => {
    const up = fakeUpstream();
    const { session, userDeltas, userFinals } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.commit(1);
    up.emit(userDelta("item_a", "make "));
    up.emit(userDelta("item_a", "it wider"));
    up.emit(userDone("item_a", "make it wider"));
    expect(userDeltas.map((d) => d.text)).toEqual(["make ", "make it wider"]);
    expect(userFinals).toEqual([{ segment: 1, text: "make it wider" }]);
  });

  it("buffers model audio per response and hands back one WAV clip at response.done", () => {
    const up = fakeUpstream();
    const { audio } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    up.emit({ type: "response.created", response: { id: "resp_1" } });
    up.emit({ type: "response.output_audio.delta", response_id: "resp_1", delta: b64([1, 2]) });
    up.emit({ type: "response.output_audio.delta", response_id: "resp_1", delta: b64([3, 4]) });
    up.emit({
      type: "response.output_audio_transcript.done",
      response_id: "resp_1",
      transcript: "done",
    });
    up.emit({ type: "response.done", response: { id: "resp_1" } });

    expect(audio).toHaveLength(1);
    expect(audio[0].mime).toBe("audio/wav");
    expect(audio[0].responseId).toBe("resp_1");
    // WAV header + the 4 PCM bytes.
    expect(audio[0].bytes.length).toBe(44 + 4);
    expect(String.fromCharCode(...audio[0].bytes.subarray(0, 4))).toBe("RIFF");
  });

  it("surfaces the model's spoken-reply transcript (logged, not the IR)", () => {
    const up = fakeUpstream();
    const { replies } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    up.emit({ type: "response.created", response: { id: "resp_1" } });
    up.emit({
      type: "response.output_audio_transcript.done",
      response_id: "resp_1",
      transcript: "got it",
    });
    up.emit({ type: "response.done", response: { id: "resp_1" } });
    expect(replies).toEqual([{ text: "got it", responseId: "resp_1" }]);
  });

  it("enforces the per-thread response cap loudly; transcription still works", () => {
    const up = fakeUpstream();
    const { session, userFinals, errors } = collect(up, 1);
    up.open();
    up.emit({ type: "session.updated" });

    session.commit(1); // response 1 — allowed
    session.commit(2); // over the cap — no response.create, a loud note
    const responseCreates = up.sent.filter((m) => m.type === "response.create");
    expect(responseCreates).toHaveLength(1);
    expect(errors.some((e) => /response cap/.test(e.message))).toBe(true);

    // Both segments still transcribe (the IR is captured regardless of the cap).
    up.emit(userDone("item_1", "first"));
    up.emit(userDone("item_2", "second"));
    expect(userFinals.map((f) => f.text)).toEqual(["first", "second"]);
  });

  it("drain resolves on the user final; close releases a pending drain", async () => {
    const up = fakeUpstream();
    const { session } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.commit(1);
    const drained = session.drain(10_000);
    session.close();
    expect(up.closed).toBe(true);
    await expect(drained).resolves.toEqual([1]);
  });

  it("an upstream error finalizes the outstanding user segment loudly", () => {
    const up = fakeUpstream();
    const { session, errors } = collect(up);
    up.open();
    up.emit({ type: "session.updated" });
    session.commit(1);
    up.error("connection reset");
    expect(errors).toContainEqual({ message: "connection reset", segment: 1 });
  });
});

describe("barge-in cancel (cancelActiveResponse)", () => {
  it("sends response.cancel and drops buffered audio", () => {
    const up = fakeUpstream();
    const audio: Array<{ responseId: string }> = [];
    const session = openRealtimeVoiceSession(
      { apiKey: "k", model: () => "gpt-realtime-2", socketFactory: up.factory, now: () => 0 },
      {
        onUserDelta: () => {},
        onUserFinal: () => {},
        onAudio: (clip) => audio.push({ responseId: clip.responseId }),
        onReplyTranscript: () => {},
        onError: () => {},
      },
    );
    up.open();
    up.emit({ type: "session.updated" });
    up.emit({ type: "response.created", response: { id: "resp_1" } });
    up.emit({ type: "response.output_audio.delta", response_id: "resp_1", delta: b64([7, 7]) });
    session.cancelActiveResponse();
    expect(up.sent.some((m) => m.type === "response.cancel")).toBe(true);
    up.emit({ type: "response.done", response: { id: "resp_1" } });
    expect(audio).toEqual([]);
  });
});

describe("pcm16ToWav", () => {
  it("prepends a 44-byte RIFF/WAVE header sized to the PCM payload", () => {
    const wav = pcm16ToWav(new Uint8Array([1, 2, 3, 4]));
    expect(wav.length).toBe(48);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
  });
});

// ── the intent-v1 processor driving a flagship voice turn ────────────────────

const enc = new TextEncoder();

interface Driver {
  feedEvents(events: IntentEvent[], fin?: boolean): Promise<void>;
  feedAudio(id: string, seq: number, bytes: Uint8Array): Promise<void>;
  fin(): Promise<void>;
  close(): Promise<void> | void;
  sent: Array<{ text: string }>;
  pushed: unknown[];
}

function driveVoice(opts: { factory?: RealtimeSocketFactory; apiKey?: string; hello?: HelloMeta }) {
  const sent: Driver["sent"] = [];
  const pushed: unknown[] = [];
  const ctx: ThreadContext = {
    threadId: "t-voice",
    hello: opts.hello ?? { intent: { tier: "flagship" } },
    sendPrompt: (text) => sent.push({ text }),
    push: (message) => pushed.push(message),
    close: () => {},
  };
  const format: ChannelFormat = createIntentV1Format({
    ...(opts.factory !== undefined ? { realtimeVoiceSocketFactory: opts.factory } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  });
  const processor: StreamProcessor = format.createProcessor(ctx);
  const send = (payload: Uint8Array, chunk: ChunkDescriptor | undefined, fin: boolean) =>
    processor.onMessage(payload, { fin, ...(chunk !== undefined ? { chunk } : {}) } as MessageMeta);
  const d: Driver = {
    feedEvents: (events, fin = false) =>
      send(enc.encode(JSON.stringify({ events })), { kind: "events" }, fin),
    feedAudio: (id, seq, bytes) =>
      send(bytes, { kind: "audio", id, seq, mime: "audio/pcm;rate=24000" }, false),
    fin: () => send(new Uint8Array(0), undefined, true),
    close: () => processor.onClose?.(),
    sent,
    pushed,
  };
  return d;
}

const speechesOf = (pushed: unknown[]): SpeechMessage[] =>
  pushed.filter((m): m is SpeechMessage => (m as { kind?: string }).kind === "speech");
const notesOf = (pushed: unknown[]): IntentEvent[] =>
  pushed.flatMap((m) =>
    ((m as { events?: IntentEvent[] }).events ?? []).filter((e) => e.type === "note"),
  );

describe("intent-v1 flagship voice turn", () => {
  it("streams PCM → commit → user transcript composes; model audio + reply surface", async () => {
    const up = fakeUpstream();
    const d = driveVoice({ factory: up.factory, apiKey: "k" });
    up.open();
    up.emit({ type: "session.updated" });

    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
    ]);
    await d.feedAudio("seg_1", 0, new Uint8Array([10, 20]));
    await d.feedEvents([{ at: 3, type: "talk-end", segment: 1, ms: 300 }]);
    // The channel committed the buffer and asked for a reply.
    expect(up.sent.some((m) => m.type === "input_audio_buffer.commit")).toBe(true);
    expect(up.sent.some((m) => m.type === "response.create")).toBe(true);

    // The USER transcript (the IR) arrives and merges as a transcript-final.
    up.emit(userDone("item_1", "make it wider"));
    // The MODEL answers aloud (audio + its spoken transcript).
    up.emit({ type: "response.created", response: { id: "resp_1" } });
    up.emit({
      type: "response.output_audio.delta",
      response_id: "resp_1",
      delta: b64([1, 2, 3, 4]),
    });
    up.emit({
      type: "response.output_audio_transcript.done",
      response_id: "resp_1",
      transcript: "done — wider",
    });
    up.emit({ type: "response.done", response: { id: "resp_1" } });

    // The model reply became a status note (never the IR).
    expect(notesOf(d.pushed).some((n) => /done — wider/.test((n as { text: string }).text))).toBe(
      true,
    );
    // The model audio became a `speech` message (WAV).
    const speeches = speechesOf(d.pushed);
    expect(speeches).toHaveLength(1);
    expect(speeches[0].mime).toBe("audio/wav");

    // fin: the lowered prompt is the USER transcript, not anything the model said.
    await d.fin();
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].text).toBe("make it wider");
    expect(up.closed).toBe(true);
  });

  it("keyless flagship finalizes the segment LOUDLY (no silent downgrade)", async () => {
    const d = driveVoice({ apiKey: "", hello: { intent: { tier: "flagship" } } });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
      { at: 3, type: "talk-end", segment: 1, ms: 200 },
    ]);
    const notes = notesOf(d.pushed);
    expect(notes.some((n) => /OPENAI_API_KEY/.test((n as { text: string }).text))).toBe(true);
  });

  it("onClose (abandoned turn) closes the upstream voice socket and sends nothing", async () => {
    const up = fakeUpstream();
    const d = driveVoice({ factory: up.factory, apiKey: "k" });
    up.open();
    up.emit({ type: "session.updated" });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
    ]);
    await d.feedAudio("seg_1", 0, new Uint8Array([1, 2, 3]));
    await d.close();
    expect(up.closed).toBe(true);
    expect(d.sent).toEqual([]);
  });
});
