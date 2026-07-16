import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import { describe, expect, it } from "vitest";
import type { ChannelFormat, MessageMeta, ThreadContext } from "./channel";
import type { ChunkDescriptor, HelloMeta } from "./frame";
import { createIntentV1Format, type SpeechMessage } from "./intent-v1";
import { mockSpeaker, openaiSpeaker, type Speaker } from "./speak";
import type { FetchLike } from "./transcribe";

// ── the TTS seam in isolation ─────────────────────────────────────────────────

describe("speak seam", () => {
  it("mockSpeaker returns deterministic non-empty bytes with a MIME", async () => {
    const result = await mockSpeaker().speak({ text: "sent" });
    expect(result.model).toBe("mock");
    expect(result.mime).toBe("audio/mpeg");
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(typeof result.latencyMs).toBe("number");
  });

  it("openaiSpeaker POSTs the documented request shape and returns the audio bytes", async () => {
    const audio = new Uint8Array([1, 2, 3, 4, 5]);
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    let seenAuth = "";
    const fetch: FetchLike = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body));
      seenAuth = (init?.headers as Record<string, string>).authorization;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => audio.buffer,
      } as unknown as Response;
    }) as unknown as FetchLike;

    const speaker = openaiSpeaker({ model: () => "gpt-4o-mini-tts", apiKey: "k", fetch });
    const result = await speaker.speak({ text: "sent", voice: "cedar" });

    expect(seenUrl).toBe("https://api.openai.com/v1/audio/speech");
    expect(seenAuth).toBe("Bearer k");
    expect(seenBody).toMatchObject({
      model: "gpt-4o-mini-tts",
      input: "sent",
      voice: "cedar",
      response_format: "mp3",
    });
    expect([...result.bytes]).toEqual([...audio]);
    expect(result.mime).toBe("audio/mpeg");
    expect(result.model).toBe("gpt-4o-mini-tts");
  });

  it("openaiSpeaker surfaces a REST error message", async () => {
    const fetch: FetchLike = (async () =>
      ({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: "invalid api key" } }),
      }) as unknown as Response) as unknown as FetchLike;
    const speaker = openaiSpeaker({ model: () => "gpt-4o-mini-tts", apiKey: "bad", fetch });
    await expect(speaker.speak({ text: "sent" })).rejects.toThrow(/invalid api key/);
  });
});

// ── the premium tier's send-received ack, through the intent-v1 processor ─────

const enc = new TextEncoder();

interface Driver {
  feedEvents(events: IntentEvent[], fin?: boolean): Promise<void>;
  fin(): Promise<void>;
  sent: Array<{ text: string }>;
  pushed: unknown[];
}

function drivePremium(opts: { speaker?: Speaker; apiKey?: string; hello?: HelloMeta }): Driver {
  const sent: Driver["sent"] = [];
  const pushed: unknown[] = [];
  const ctx: ThreadContext = {
    threadId: "t-ack",
    hello: opts.hello ?? { intent: { tier: "premium" } },
    sendPrompt: (text) => sent.push({ text }),
    push: (message) => pushed.push(message),
    close: () => {},
  };
  const format: ChannelFormat = createIntentV1Format({
    ...(opts.speaker !== undefined ? { speaker: opts.speaker } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  });
  const processor = format.createProcessor(ctx);
  const send = (payload: Uint8Array, chunk: ChunkDescriptor | undefined, fin: boolean) =>
    processor.onMessage(payload, { fin, ...(chunk !== undefined ? { chunk } : {}) } as MessageMeta);
  return {
    feedEvents: (events, fin = false) =>
      send(enc.encode(JSON.stringify({ events })), { kind: "events" }, fin),
    fin: () => send(new Uint8Array(0), undefined, true),
    sent,
    pushed,
  };
}

/** A completed dictation turn (a text transcript so the compose is non-empty). */
const dictationTurn: IntentEvent[] = [
  { at: 1, type: "armed", on: true },
  { at: 2, type: "thread-open", trigger: "talk" },
  { at: 3, type: "talk-start", segment: 1 },
  { at: 4, type: "talk-end", segment: 1, ms: 200 },
  {
    at: 5,
    type: "transcript-final",
    segment: 1,
    text: "make the plot wider",
    latencyMs: 100,
    model: "mock",
  },
];

describe("intent-v1 premium TTS acks", () => {
  it("pushes a spoken 'sent' speech message after a successful send", async () => {
    const d = drivePremium({ speaker: mockSpeaker() });
    await d.feedEvents(dictationTurn);
    await d.fin();

    // The prompt was sent…
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].text).toBe("make the plot wider");
    // …and a base64 `speech` message followed, labelled with the spoken phrase.
    const speeches = d.pushed.filter(
      (m): m is SpeechMessage => (m as { kind?: string }).kind === "speech",
    );
    expect(speeches).toHaveLength(1);
    expect(speeches[0]).toMatchObject({ kind: "speech", threadId: "t-ack", label: "sent" });
    expect(speeches[0].id).toMatch(/^ack_/);
    expect(speeches[0].mime).toBe("audio/mpeg");
    expect(speeches[0].data.length).toBeGreaterThan(0);
  });

  it("does NOT speak for a cancelled turn (nothing sent, nothing spoken)", async () => {
    const d = drivePremium({ speaker: mockSpeaker() });
    await d.feedEvents([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "thread-close", reason: "cancel" },
    ]);
    await d.fin();
    expect(d.sent).toEqual([]);
    expect(d.pushed.filter((m) => (m as { kind?: string }).kind === "speech")).toEqual([]);
  });

  it("keyless premium degrades LOUDLY — a note, never a silent skip", async () => {
    // audioBack:"acks" requested, forced-empty key, no speaker override → no seam.
    const d = drivePremium({
      apiKey: "",
      hello: { intent: { tier: "premium", audioBack: "acks" } },
    });
    await d.feedEvents(dictationTurn);
    await d.fin();

    expect(d.sent).toHaveLength(1); // the prompt still lands
    // No audio, but a loud note explaining why (never a silent downgrade to rapid).
    const speeches = d.pushed.filter((m) => (m as { kind?: string }).kind === "speech");
    expect(speeches).toEqual([]);
    const notes = d.pushed.flatMap((m) =>
      ((m as { events?: IntentEvent[] }).events ?? []).filter((e) => e.type === "note"),
    );
    expect(notes.some((n) => /OPENAI_API_KEY/.test((n as { text: string }).text))).toBe(true);
  });
});
