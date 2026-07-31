/**
 * Pricing a realtime session — the mapping into genai-prices' shape, the
 * catalog lookup, and the two formatters the usage strip reads through.
 *
 * The one that matters most is the cached-AUDIO split. Everything else here is
 * arithmetic; that one is the difference between a priced session and a
 * silently unpriced one.
 */
import { describe, expect, it } from "vitest";
import {
  abbreviateTokens,
  formatUsd,
  priceCandidates,
  priceRealtimeUsage,
  usageFromRealtimeResponse,
} from "./cost";

/** A representative voice turn: mostly cached audio history. */
const realtimeUsage = {
  input_tokens: 5000,
  output_tokens: 500,
  input_token_details: {
    text_tokens: 1000,
    audio_tokens: 4000,
    cached_tokens: 3800,
    cached_tokens_details: { text_tokens: 600, audio_tokens: 3200 },
  },
  output_token_details: { text_tokens: 50, audio_tokens: 450 },
};

describe("mapping a response.done usage", () => {
  it("carries the cached AUDIO subset separately — without it nothing prices", () => {
    // genai-prices' identity is
    //   uncached_text = input − input_audio − (cache_read − cache_audio_read)
    // and a negative is REJECTED. Fold cached audio into cache_read alone and
    // every voice turn with history throws, i.e. goes silently unpriced.
    const usage = usageFromRealtimeResponse(realtimeUsage);
    expect(usage).toEqual({
      input_tokens: 5000,
      output_tokens: 500,
      input_audio_tokens: 4000,
      cache_read_tokens: 3800,
      cache_audio_read_tokens: 3200,
      output_audio_tokens: 450,
    });
  });

  it("is tolerant — garbage in, undefined out, never a throw", () => {
    expect(usageFromRealtimeResponse(undefined)).toBeUndefined();
    expect(usageFromRealtimeResponse({})).toBeUndefined();
    expect(usageFromRealtimeResponse({ input_tokens: "lots" })).toBeUndefined();
    // A payload with no details at all still prices on the totals.
    expect(usageFromRealtimeResponse({ input_tokens: 10, output_tokens: 2 })).toEqual({
      input_tokens: 10,
      output_tokens: 2,
    });
  });
});

describe("pricing", () => {
  it("prices a real turn, and the cache credit is worth ~3x", () => {
    const withCache = priceRealtimeUsage("gpt-realtime", usageFromRealtimeResponse(realtimeUsage)!);
    expect(withCache?.usd).toBeCloseTo(0.05832, 5);
    expect(withCache?.approximate).toBe(false);

    // The same turn with the cache credit dropped — the error a broken mapping
    // would produce if it degraded instead of throwing.
    const noCache = priceRealtimeUsage("gpt-realtime", {
      input_tokens: 5000,
      input_audio_tokens: 4000,
      output_tokens: 500,
      output_audio_tokens: 450,
    });
    expect(noCache?.usd).toBeCloseTo(0.1616, 4);
  });

  it("falls back to the base model id, and SAYS it is approximate", () => {
    // Our default is gpt-realtime-2.1, which the catalog does not carry.
    const priced = priceRealtimeUsage("gpt-realtime-2.1", { input_tokens: 1000 });
    expect(priced?.pricedAs).toBe("gpt-realtime");
    expect(priced?.approximate).toBe(true);
  });

  it("never trims to something generic enough to match the wrong family", () => {
    // "2.1" is ONE segment, so there is no intermediate "gpt-realtime-2".
    expect(priceCandidates("gpt-realtime-2.1")).toEqual(["gpt-realtime-2.1", "gpt-realtime"]);
    expect(priceCandidates("gpt-4o-realtime-preview-2024-10-01")).toEqual([
      "gpt-4o-realtime-preview-2024-10-01",
      "gpt-4o-realtime-preview-2024-10",
      "gpt-4o-realtime-preview-2024",
      "gpt-4o-realtime-preview",
      "gpt-4o-realtime",
      "gpt-4o",
    ]);
    // Two segments is the floor — `gpt-realtime` must never degrade to `gpt`.
    expect(priceCandidates("gpt-realtime")).toEqual(["gpt-realtime"]);
    expect(priceCandidates("solo")).toEqual(["solo"]);
  });

  it("an unknown model is UNPRICED, never zero", () => {
    expect(priceRealtimeUsage("no-such-model", { input_tokens: 1000 })).toBeUndefined();
  });

  it("never throws, whatever the usage", () => {
    // calcPrice validates aggressively; a refusal must not disturb a live
    // conversation, so it degrades to unpriced.
    expect(() =>
      priceRealtimeUsage("gpt-realtime", {
        input_tokens: 10,
        input_audio_tokens: 10,
        cache_read_tokens: 9_999,
      }),
    ).not.toThrow();
  });
});

describe("reading it at a glance", () => {
  it("abbreviates without hiding small numbers", () => {
    // 47 must not round to "0.0k" — small counts are exactly when you are
    // watching to see whether anything is accumulating at all.
    expect(abbreviateTokens(0)).toBe("0");
    expect(abbreviateTokens(47)).toBe("47");
    expect(abbreviateTokens(999)).toBe("999");
    expect(abbreviateTokens(1_000)).toBe("1.0k");
    expect(abbreviateTokens(13_240)).toBe("13.2k");
    expect(abbreviateTokens(456_000)).toBe("456k");
    expect(abbreviateTokens(1_400_000)).toBe("1.40M");
  });

  it("keeps dollars useful across four orders of magnitude", () => {
    // "$0.00" for the first several minutes would read as free rather than
    // small, which is the opposite of what this display is for.
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0004)).toBe("$0.0004");
    expect(formatUsd(0.042)).toBe("$0.042");
    expect(formatUsd(3.5)).toBe("$3.50");
  });
});
