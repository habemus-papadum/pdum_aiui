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
    // mock — offline, keyless, both seams mock.
    expect(expandTier("mock")).toMatchObject({ transcriber: "mock", corrector: "mock" });
    // standard (the default) reproduces today's REST-mini backends.
    expect(expandTier("standard")).toMatchObject({
      transcriber: "openai",
      model: "gpt-4o-mini-transcribe",
      corrector: "openai",
      correctionModel: "gpt-4o-mini",
      audioBack: "off",
    });
    // rapid — streaming STT, no voice back.
    expect(expandTier("rapid")).toMatchObject({
      transcriber: "openai-realtime",
      realtimeModel: "gpt-realtime-whisper",
      audioBack: "off",
    });
    // premium — rapid + spoken TTS acks.
    expect(expandTier("premium")).toMatchObject({
      transcriber: "openai-realtime",
      audioBack: "acks",
      ttsModel: "gpt-4o-mini-tts",
    });
    // flagship — the conversational voice model.
    expect(expandTier("flagship")).toMatchObject({
      transcriber: "openai-voice",
      audioBack: "voice",
      realtimeVoiceModel: "gpt-realtime-2",
      realtimeVoice: "cedar",
      realtimeTools: "none",
    });
  });

  it("an absent/unknown tier expands to the bare defaults (standard behavior)", () => {
    expect(expandTier(undefined).transcriber).toBe(DEFAULT_INTENT_CONFIG.transcriber);
    expect(expandTier("bogus").transcriber).toBe(DEFAULT_INTENT_CONFIG.transcriber);
  });

  it("effectiveConfig layers DEFAULT ← tier preset ← explicit; a bare tier picks the preset", () => {
    const flagship = effectiveConfig({ tier: "flagship" }, {});
    expect(flagship.transcriber).toBe("openai-voice");
    expect(flagship.audioBack).toBe("voice");
    expect(flagship.realtimeVoiceModel).toBe("gpt-realtime-2");
  });

  it("an explicit fine field WINS over the tier preset (choice #4)", () => {
    // flagship runs the voice model, but `model` is pinned to whisper-1.
    const cfg = effectiveConfig({ tier: "flagship", model: "whisper-1" }, {});
    expect(cfg.transcriber).toBe("openai-voice"); // from the preset
    expect(cfg.model).toBe("whisper-1"); // explicit wins
  });

  it("no tier reproduces standard exactly (today's default, unchanged)", () => {
    const cfg = effectiveConfig({}, {});
    expect(cfg.transcriber).toBe("openai");
    expect(cfg.model).toBe("gpt-4o-mini-transcribe");
    expect(cfg.corrector).toBe("openai");
    expect(cfg.audioBack).toBe("off");
  });
});

describe("tiers: the switch delta trap (overridesForApply)", () => {
  const base = effectiveConfig({}, {}); // DEFAULT+standard, vite intent = {}

  it("the exact scenario: set tier rapid (no transcriber override) → switch flagship applies", () => {
    // Set tier rapid — the persisted delta is JUST {tier}, no frozen fine fields.
    const rapidDelta = overridesForApply({ tier: "rapid" }, base);
    expect(rapidDelta).toEqual({ tier: "rapid" });
    expect("transcriber" in rapidDelta).toBe(false);

    // Now switch to flagship — flagship's fields apply, not rapid's frozen ones.
    const flagshipDelta = overridesForApply({ tier: "flagship" }, base);
    expect(flagshipDelta).toEqual({ tier: "flagship" });
    const effective = effectiveConfig({}, flagshipDelta);
    expect(effective.transcriber).toBe("openai-voice");
    expect(effective.audioBack).toBe("voice");
  });

  it("a panel switch drops stale tier-controlled fields that match the new preset", () => {
    // The editor still literally holds the previous tier's expansion; switching to
    // flagship with those fields present must NOT freeze redundant ones.
    const editedFullFlagship = { ...effectiveConfig({ tier: "flagship" }, {}) };
    const delta = overridesForApply(editedFullFlagship, base);
    // Only the tier survives — every fine field equals flagship's preset, so it is
    // re-derived by expansion rather than frozen as an override.
    expect(delta.tier).toBe("flagship");
    expect(delta.transcriber).toBeUndefined();
    expect(delta.audioBack).toBeUndefined();
    expect(delta.realtimeVoiceModel).toBeUndefined();
  });

  it("keeps an explicit fine field that diverges from the new tier's preset", () => {
    // Switching to flagship AND pinning model=whisper-1 in one apply: model is not
    // set by flagship's preset, so it diverges and is kept.
    const delta = overridesForApply({ tier: "flagship", model: "whisper-1" }, base);
    expect(delta).toMatchObject({ tier: "flagship", model: "whisper-1" });
    expect(effectiveConfig({}, delta).model).toBe("whisper-1");
  });

  it("without a tier change, overridesForApply is a plain delta (no reconciliation)", () => {
    // Editing a fine field alone (tier unchanged) behaves exactly like before.
    expect(overridesForApply({ talkMode: "toggle" }, base)).toEqual({ talkMode: "toggle" });
  });

  it("TIER_PRESETS covers every tier the schema accepts", () => {
    expect(Object.keys(TIER_PRESETS).sort()).toEqual([
      "flagship",
      "live-gemini",
      "live-openai",
      "mock",
      "premium",
      "rapid",
      "standard",
    ]);
  });
});

describe("layering + persistence", () => {
  it("effectiveConfig applies DEFAULT ← vite ← overrides in order", () => {
    const effective = effectiveConfig({ mockWordMs: 99 }, { talkMode: "toggle" });
    expect(effective.talkMode).toBe("toggle"); // override
    expect(effective.mockWordMs).toBe(99); // vite option
    expect(effective.corrector).toBe(DEFAULT_INTENT_CONFIG.corrector); // default
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
