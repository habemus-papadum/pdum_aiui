/**
 * openai.test.ts — the ported OpenAI GA wire facts, pinned: the browser
 * credential presentation (subprotocol, bare URL), the session.update
 * assert + echo check, incremental-delta accumulation, item↔segment
 * binding (pre-commit included), the failed event, discard's buffer clear,
 * and the token→word logprob fold.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
  OPENAI_REALTIME_URL,
  openaiTranscriptionTransport,
  wordsFromTokenLogprobs,
} from "./openai";
import { fakeSocket, pcmMs, recordingCallbacks } from "./test-support/fakes";

function stubKeySource() {
  const minted: Array<Record<string, unknown>> = [];
  return {
    minted,
    keySource: {
      describe: () => "stub",
      credential: async (session: Record<string, unknown>) => {
        minted.push(session);
        return { ek: "ek_test_fixture", expiresAt: 0 };
      },
    },
  };
}

async function openTranscription(
  extra: Partial<Parameters<typeof openaiTranscriptionTransport>[0]> = {},
) {
  const socket = fakeSocket();
  const record = recordingCallbacks();
  const { minted, keySource } = stubKeySource();
  const transport = openaiTranscriptionTransport({
    keySource,
    socketFactory: socket.factory,
    now: () => 5000,
    ...extra,
  });
  const connection = await transport.open(record.callbacks);
  return { socket, record, connection, minted };
}

function ready(socket: ReturnType<typeof fakeSocket>, session: object = {}): void {
  socket.message({ type: "session.updated", session });
}

describe("openaiTranscriptionTransport", () => {
  it("presents the ek_ as the browser subprotocol on the bare GA URL", async () => {
    const { socket, minted } = await openTranscription();
    expect(socket.url()).toBe(OPENAI_REALTIME_URL);
    expect(socket.protocols()).toEqual(["realtime", "openai-insecure-api-key.ek_test_fixture"]);
    // The mint saw the SAME wire session config the engine asserts.
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: DEFAULT_OPENAI_TRANSCRIPTION_MODEL },
          turn_detection: null,
        },
      },
    });
  });

  it("asserts its config with one session.update on open and diffs the echo", async () => {
    const { socket, record } = await openTranscription();
    socket.open();
    const update = socket.sentJson()[0];
    expect(update.type).toBe("session.update");
    // A server that re-enables turn detection is a mismatch worth reporting —
    // the manual-commit premise is exactly the thing to prove.
    ready(socket, {
      audio: {
        input: { turn_detection: { type: "server_vad" }, transcription: { model: "other" } },
      },
    });
    expect(record.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "config-mismatch", param: "turn_detection" }),
    );
    expect(record.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "config-mismatch", param: "transcription.model" }),
    );
  });

  it("carries the delay knob only for gpt-realtime-whisper", async () => {
    const withWhisper = await openTranscription({ delay: "xhigh" });
    expect(withWhisper.minted[0]).toMatchObject({
      audio: { input: { transcription: { model: "gpt-realtime-whisper", delay: "xhigh" } } },
    });
    const withMini = await openTranscription({
      delay: "xhigh",
      transcriptionModel: "gpt-4o-mini-transcribe",
    });
    const transcription = (
      withMini.minted[0] as {
        audio: { input: { transcription: Record<string, unknown> } };
      }
    ).audio.input.transcription;
    expect(transcription).toEqual({ model: "gpt-4o-mini-transcribe" }); // delay rejected upstream
  });

  it("accumulates incremental deltas per item and binds pre-commit to the streaming segment", async () => {
    const { socket, record, connection } = await openTranscription();
    socket.open();
    ready(socket);
    connection.appendAudio(4, pcmMs(200));
    socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "i1",
      delta: "hel",
    });
    socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "i1",
      delta: "lo",
    });
    expect(record.deltas).toEqual([
      [4, "hel"],
      [4, "hello"],
    ]);
  });

  it("completes a committed segment with words folded from token logprobs", async () => {
    const { socket, record, connection } = await openTranscription();
    socket.open();
    ready(socket);
    connection.appendAudio(0, pcmMs(200));
    connection.commit(0);
    expect(socket.sentJson().at(-1)).toEqual({ type: "input_audio_buffer.commit" });
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "i9",
      transcript: "hello world",
      logprobs: [
        { token: "hello", logprob: -0.1 },
        { token: " wor", logprob: -0.4 },
        { token: "ld", logprob: -0.2 },
      ],
    });
    expect(record.finals).toHaveLength(1);
    const [segment, final] = record.finals[0];
    expect(segment).toBe(0);
    expect(final.text).toBe("hello world");
    expect(final.model).toBe(DEFAULT_OPENAI_TRANSCRIPTION_MODEL);
    // A word's confidence is its WORST token.
    expect(final.words).toEqual([
      { text: "hello", logprob: -0.1 },
      { text: "world", logprob: -0.4 },
    ]);
  });

  it("resolves a failed transcription loudly, attributed to its segment", async () => {
    const { socket, record, connection } = await openTranscription();
    socket.open();
    ready(socket);
    connection.appendAudio(2, pcmMs(200));
    connection.commit(2);
    socket.message({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "i2",
      error: { message: "audio too noisy" },
    });
    expect(record.errors).toEqual([["audio too noisy", 2]]);
    // …and the segment left the pending queue: drain resolves clean.
    expect(await connection.drain(10)).toEqual([]);
  });

  it("discard clears the upstream buffer and drops the item's late events", async () => {
    const { socket, record, connection } = await openTranscription();
    socket.open();
    ready(socket);
    connection.appendAudio(1, pcmMs(50));
    socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "i5",
      delta: "st",
    });
    connection.discard(1);
    expect(socket.sentJson().at(-1)).toEqual({ type: "input_audio_buffer.clear" });
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "i5",
      transcript: "stray",
    });
    expect(record.finals).toHaveLength(0);
    expect(record.diagnostics).toContainEqual(expect.objectContaining({ kind: "orphan-result" }));
  });

  it("fails outstanding segments loudly on a vendor error frame", async () => {
    const { socket, record, connection } = await openTranscription();
    socket.open();
    ready(socket);
    connection.appendAudio(0, pcmMs(200));
    connection.commit(0);
    socket.message({ type: "error", error: { message: "invalid session" } });
    expect(record.errors).toEqual([["invalid session", 0]]);
    connection.commit(1); // dead session: refused loudly, never queued
    expect(record.errors.at(-1)).toEqual(["realtime session unavailable", 1]);
  });
});

describe("wordsFromTokenLogprobs", () => {
  it("folds tokens to words with min-logprob confidence", () => {
    expect(
      wordsFromTokenLogprobs("a bc", [
        { token: "a", logprob: -0.1 },
        { token: " b", logprob: -0.5 },
        { token: "c", logprob: -0.2 },
      ]),
    ).toEqual([
      { text: "a", logprob: -0.1 },
      { text: "bc", logprob: -0.5 },
    ]);
  });

  it("degrades to no words on drift or malformed input", () => {
    expect(wordsFromTokenLogprobs("hello", [{ token: "goodbye", logprob: -0.1 }])).toBeUndefined();
    expect(wordsFromTokenLogprobs("x", [{ token: "x" }])).toBeUndefined();
    expect(wordsFromTokenLogprobs("x", [])).toBeUndefined();
  });
});
