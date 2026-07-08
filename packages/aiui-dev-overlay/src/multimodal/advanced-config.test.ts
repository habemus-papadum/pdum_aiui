// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_INTENT_CONFIG, expandTier, TIER_PRESETS } from "../intent-pipeline";
import { installLocalStorage } from "../test-support/local-storage";
import {
  clearIntentOverrides,
  computeOverrides,
  effectiveConfig,
  INTENT_CONFIG_STORAGE_KEY,
  loadIntentOverrides,
  overridesForApply,
  saveIntentOverrides,
  validateIntentConfig,
} from "./advanced-config";

let uninstallStorage: () => void;
beforeEach(() => {
  uninstallStorage = installLocalStorage();
});
afterEach(() => {
  uninstallStorage();
});

describe("validateIntentConfig (strict — typos fail loudly)", () => {
  it("accepts a valid full config", () => {
    const result = validateIntentConfig({ ...DEFAULT_INTENT_CONFIG });
    expect(result.ok).toBe(true);
  });

  it("accepts a partial config (missing keys inherit the base)", () => {
    expect(validateIntentConfig({ talkMode: "toggle" }).ok).toBe(true);
  });

  it("rejects an unknown key, naming it", () => {
    const result = validateIntentConfig({ talkMdoe: "hold" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('unknown config key "talkMdoe"');
      expect(result.error).toContain("known keys");
    }
  });

  it("rejects a type mismatch, naming the key and expected type", () => {
    const result = validateIntentConfig({ inkFadeSec: "six" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"inkFadeSec"');
      expect(result.error).toContain("must be a number");
    }
  });

  it("rejects an out-of-set enum value", () => {
    const result = validateIntentConfig({ transcriber: "whisper" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/"transcriber" must be one of "mock", "openai"/);
    }
  });

  it("validates nested objects and their unknown keys", () => {
    expect(validateIntentConfig({ arming: { enabled: "yes" } }).ok).toBe(false);
    const unknownNested = validateIntentConfig({ arming: { keyy: "`" } });
    expect(unknownNested.ok).toBe(false);
    if (!unknownNested.ok) {
      expect(unknownNested.error).toContain('"arming.keyy"');
    }
    expect(validateIntentConfig({ arming: { key: "~", enabled: false } }).ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validateIntentConfig(42).ok).toBe(false);
    expect(validateIntentConfig([1, 2]).ok).toBe(false);
    expect(validateIntentConfig(null).ok).toBe(false);
  });

  it("accepts the tier dial and the new audio-back / flagship fields", () => {
    expect(validateIntentConfig({ tier: "flagship" }).ok).toBe(true);
    expect(validateIntentConfig({ transcriber: "openai-voice" }).ok).toBe(true);
    expect(
      validateIntentConfig({
        audioBack: "acks",
        ttsModel: "gpt-4o-mini-tts",
        ttsVoice: "cedar",
        realtimeVoiceModel: "gpt-realtime-2",
        realtimeVoice: "cedar",
        realtimeTools: "none",
        realtimeReasoning: "low",
      }).ok,
    ).toBe(true);
  });

  it("rejects an out-of-set tier / audioBack value, naming the key", () => {
    const badTier = validateIntentConfig({ tier: "deluxe" });
    expect(badTier.ok).toBe(false);
    if (!badTier.ok) {
      expect(badTier.error).toMatch(/"tier" must be one of/);
    }
    expect(validateIntentConfig({ audioBack: "loud" }).ok).toBe(false);
  });
});

describe("computeOverrides (the persisted delta)", () => {
  it("keeps only keys that differ from the base", () => {
    const base = { ...DEFAULT_INTENT_CONFIG, mockWordMs: 99 };
    const edited = { ...base, talkMode: "toggle" as const, mockWordMs: 99 };
    expect(computeOverrides(edited, base)).toEqual({ talkMode: "toggle" });
  });

  it("ignores keys equal to the base and undefined values", () => {
    const base = { ...DEFAULT_INTENT_CONFIG };
    expect(computeOverrides({ talkMode: "hold", inkFadeSec: undefined }, base)).toEqual({});
  });

  it("deep-compares nested objects", () => {
    const base = { ...DEFAULT_INTENT_CONFIG };
    expect(computeOverrides({ arming: { key: "`", enabled: true } }, base)).toEqual({});
    expect(computeOverrides({ arming: { key: "~", enabled: true } }, base)).toEqual({
      arming: { key: "~", enabled: true },
    });
  });
});

describe("tiers: expansion + merge precedence", () => {
  it("expands each tier into its expected fine fields (the expansion table)", () => {
    // mock — offline, keyless, unsurfaced (tests/dev only).
    expect(expandTier("mock")).toMatchObject({ transcriber: "mock" });
    // rapid — streaming whisper, no voice back. The default.
    expect(expandTier("rapid")).toMatchObject({
      transcriber: "openai-realtime",
      realtimeModel: "gpt-realtime-whisper",
      audioBack: "off",
    });
    // premium — the higher-quality streaming model + spoken TTS acks.
    expect(expandTier("premium")).toMatchObject({
      transcriber: "openai-realtime",
      realtimeModel: "gpt-4o-mini-transcribe",
      audioBack: "acks",
      ttsModel: "gpt-4o-mini-tts",
    });
  });

  it("legacy tier names expand exactly as their pre-pivot presets read", () => {
    // Old persisted configs / hellos keep meaning what they meant.
    expect(expandTier("standard")).toMatchObject({
      transcriber: "openai",
      model: "gpt-4o-mini-transcribe",
      audioBack: "off",
    });
    expect(expandTier("flagship")).toMatchObject({
      transcriber: "openai-voice",
      audioBack: "voice",
      realtimeVoiceModel: "gpt-realtime-2",
      realtimeVoice: "cedar",
    });
    expect(expandTier("live-gemini")).toMatchObject({
      submode: "realtime",
      liveVendor: "gemini",
      liveModel: "gemini-3.1-flash-live-preview",
    });
    expect(expandTier("live-openai")).toMatchObject({
      submode: "realtime",
      liveVendor: "openai",
      liveModel: "gpt-realtime-2",
    });
  });

  it("an absent/unknown tier expands to the bare defaults", () => {
    expect(expandTier(undefined).transcriber).toBe(DEFAULT_INTENT_CONFIG.transcriber);
    expect(expandTier("bogus").transcriber).toBe(DEFAULT_INTENT_CONFIG.transcriber);
  });

  it("effectiveConfig layers DEFAULT ← tier preset ← explicit; a bare tier picks the preset", () => {
    const premium = effectiveConfig({ tier: "premium" }, {});
    expect(premium.transcriber).toBe("openai-realtime");
    expect(premium.audioBack).toBe("acks");
    expect(premium.ttsModel).toBe("gpt-4o-mini-tts");
  });

  it("an explicit fine field WINS over the tier preset (choice #4)", () => {
    // premium runs gpt-4o-mini-transcribe, but realtimeModel is pinned back.
    const cfg = effectiveConfig({ tier: "premium", realtimeModel: "gpt-realtime-whisper" }, {});
    expect(cfg.audioBack).toBe("acks"); // from the preset
    expect(cfg.realtimeModel).toBe("gpt-realtime-whisper"); // explicit wins
  });

  it("no tier expands to rapid (streaming whisper — the default rung)", () => {
    const cfg = effectiveConfig({}, {});
    expect(cfg.transcriber).toBe("openai-realtime");
    expect(cfg.realtimeModel).toBe("gpt-realtime-whisper");
    expect(cfg.audioBack).toBe("off");
    expect(cfg.linter).toBe("off");
  });
});

describe("tiers: the switch delta trap (overridesForApply)", () => {
  const base = effectiveConfig({}, {}); // DEFAULT+rapid, vite intent = {}

  it("the exact scenario: set tier premium (no transcriber override) → switch back applies", () => {
    // Set tier premium — the persisted delta is JUST {tier}, no frozen fine fields.
    const premiumDelta = overridesForApply({ tier: "premium" }, base);
    expect(premiumDelta).toEqual({ tier: "premium" });
    expect("realtimeModel" in premiumDelta).toBe(false);

    // Now switch to rapid — rapid's fields apply, not premium's frozen ones.
    const rapidDelta = overridesForApply({ tier: "rapid" }, base);
    expect(rapidDelta).toEqual({ tier: "rapid" });
    const effective = effectiveConfig({}, rapidDelta);
    expect(effective.realtimeModel).toBe("gpt-realtime-whisper");
    expect(effective.audioBack).toBe("off");
  });

  it("a panel switch drops stale tier-controlled fields that match the new preset", () => {
    // The editor still literally holds the previous tier's expansion; switching to
    // premium with those fields present must NOT freeze redundant ones.
    const editedFullPremium = { ...effectiveConfig({ tier: "premium" }, {}) };
    const delta = overridesForApply(editedFullPremium, base);
    // Only the tier survives — every fine field equals premium's preset, so it is
    // re-derived by expansion rather than frozen as an override.
    expect(delta.tier).toBe("premium");
    expect(delta.transcriber).toBeUndefined();
    expect(delta.audioBack).toBeUndefined();
    expect(delta.ttsModel).toBeUndefined();
  });

  it("keeps an explicit fine field that diverges from the new tier's preset", () => {
    // Switching to premium AND pinning model=whisper-1 in one apply: model is not
    // set by premium's preset, so it diverges and is kept.
    const delta = overridesForApply({ tier: "premium", model: "whisper-1" }, base);
    expect(delta).toMatchObject({ tier: "premium", model: "whisper-1" });
    expect(effectiveConfig({}, delta).model).toBe("whisper-1");
  });

  it("without a tier change, overridesForApply is a plain delta (no reconciliation)", () => {
    // Editing a fine field alone (tier unchanged) behaves exactly like before.
    expect(overridesForApply({ talkMode: "toggle" }, base)).toEqual({ talkMode: "toggle" });
  });

  it("TIER_PRESETS holds exactly the current tiers; legacy names still expand", () => {
    expect(Object.keys(TIER_PRESETS).sort()).toEqual(["mock", "premium", "rapid"]);
    // The schema also accepts the retired names — those expand via the alias
    // table (asserted above), never to bare defaults.
    for (const legacy of ["standard", "flagship", "live-gemini", "live-openai"]) {
      expect(expandTier(legacy)).not.toEqual(expandTier("definitely-unknown"));
    }
  });
});

describe("layering + persistence", () => {
  it("effectiveConfig applies DEFAULT ← vite ← overrides in order", () => {
    const effective = effectiveConfig({ mockWordMs: 99 }, { talkMode: "toggle" });
    expect(effective.talkMode).toBe("toggle"); // override
    expect(effective.mockWordMs).toBe(99); // vite option
  });

  it("round-trips overrides through localStorage under the aiui key", () => {
    saveIntentOverrides({ talkMode: "toggle" });
    expect(localStorage.getItem(INTENT_CONFIG_STORAGE_KEY)).toBe('{"talkMode":"toggle"}');
    expect(loadIntentOverrides()).toEqual({ talkMode: "toggle" });
    clearIntentOverrides();
    expect(loadIntentOverrides()).toEqual({});
  });

  it("ignores corrupt or invalid stored overrides", () => {
    localStorage.setItem(INTENT_CONFIG_STORAGE_KEY, "{not json");
    expect(loadIntentOverrides()).toEqual({});
    localStorage.setItem(INTENT_CONFIG_STORAGE_KEY, '{"bogusKey":1}');
    expect(loadIntentOverrides()).toEqual({});
  });
});
