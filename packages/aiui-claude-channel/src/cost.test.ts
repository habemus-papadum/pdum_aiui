import { describe, expect, it } from "vitest";
import {
  estimatedTtsUsage,
  normalizeUsage,
  priceCall,
  usageFromChatCompletions,
  usageFromRealtimeResponse,
  usageFromTranscription,
} from "./cost";

describe("normalizeUsage", () => {
  it("raises totals to cover audio subsets (calcPrice rejects the inverse)", () => {
    expect(normalizeUsage({ input_audio_tokens: 120 })).toEqual({
      input_tokens: 120,
      input_audio_tokens: 120,
    });
    expect(normalizeUsage({ input_tokens: 200, input_audio_tokens: 120 })).toEqual({
      input_tokens: 200,
      input_audio_tokens: 120,
    });
    expect(normalizeUsage({ output_tokens: 10, output_audio_tokens: 300 })).toEqual({
      output_tokens: 300,
      output_audio_tokens: 300,
    });
  });
});

describe("priceCall", () => {
  it("prices a multimodal STT call (audio input tokens dominate)", () => {
    // The exact usage a real gpt-4o-mini-transcribe call returned in the field.
    const cost = priceCall("openai", "gpt-4o-mini-transcribe", {
      input_tokens: 120,
      input_audio_tokens: 120,
      output_tokens: 19,
    });
    expect(cost.usd).toBeGreaterThan(0);
    expect(cost.provider).toBe("openai");
    expect(cost.model).toBe("gpt-4o-mini-transcribe");
    // Sanity: audio-in pricing beats text-in — the same tokens priced as pure
    // text would be cheaper. Guards against silently dropping the audio field.
    const asText = priceCall("openai", "gpt-4o-mini-transcribe", {
      input_tokens: 120,
      output_tokens: 19,
    });
    expect(cost.usd ?? 0).toBeGreaterThan(asText.usd ?? 0);
  });

  it("keeps usage but omits usd for models the catalog does not know", () => {
    const cost = priceCall("openai", "gpt-not-a-real-model-xyz", { input_tokens: 10 });
    expect(cost.usd).toBeUndefined();
    expect(cost.usage).toEqual({ input_tokens: 10 });
  });

  it("never throws — even usage the library would reject is normalized in", () => {
    const cost = priceCall("openai", "gpt-4o-mini-tts", {
      input_tokens: 12,
      output_audio_tokens: 300, // subset without a total: raw calcPrice throws
    });
    expect(cost.usd).toBeGreaterThan(0);
  });

  it("marks estimates", () => {
    const cost = priceCall("openai", "gpt-4o-mini-tts", estimatedTtsUsage("sent"), {
      estimated: true,
    });
    expect(cost.estimated).toBe(true);
  });

  it("prices google models too (the realtime submode's vendor)", () => {
    const cost = priceCall("google", "gemini-2.5-flash", {
      input_tokens: 1000,
      input_audio_tokens: 500,
      output_tokens: 100,
    });
    expect(cost.usd).toBeGreaterThan(0);
  });
});

describe("usage mappers", () => {
  it("chat completions: prompt/completion (+details) → totals and subsets", () => {
    expect(
      usageFromChatCompletions({
        prompt_tokens: 900,
        completion_tokens: 120,
        prompt_tokens_details: { cached_tokens: 100, audio_tokens: 0 },
      }),
    ).toEqual({
      input_tokens: 900,
      output_tokens: 120,
      input_audio_tokens: 0,
      cache_read_tokens: 100,
    });
    expect(usageFromChatCompletions(undefined)).toBeUndefined();
    expect(usageFromChatCompletions({ nope: 1 })).toBeUndefined();
  });

  it("transcription: input_token_details.audio_tokens → input_audio_tokens", () => {
    expect(
      usageFromTranscription({
        input_tokens: 120,
        output_tokens: 19,
        input_token_details: { text_tokens: 0, audio_tokens: 120 },
      }),
    ).toEqual({ input_tokens: 120, output_tokens: 19, input_audio_tokens: 120 });
  });

  it("realtime response.done: nested details on both sides", () => {
    expect(
      usageFromRealtimeResponse({
        input_tokens: 900,
        output_tokens: 350,
        input_token_details: { text_tokens: 500, audio_tokens: 400, cached_tokens: 100 },
        output_token_details: { text_tokens: 200, audio_tokens: 150 },
      }),
    ).toEqual({
      input_tokens: 900,
      output_tokens: 350,
      input_audio_tokens: 400,
      cache_read_tokens: 100,
      output_audio_tokens: 150,
    });
  });

  it("tts estimate: ~4 chars per token, input side only", () => {
    expect(estimatedTtsUsage("sent")).toEqual({ input_tokens: 1 });
    expect(estimatedTtsUsage("a".repeat(40))).toEqual({ input_tokens: 10 });
  });
});
