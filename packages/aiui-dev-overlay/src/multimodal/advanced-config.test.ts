// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_INTENT_CONFIG } from "../intent-pipeline";
import { installLocalStorage } from "../test-support/local-storage";
import {
  clearIntentOverrides,
  computeOverrides,
  effectiveConfig,
  INTENT_CONFIG_STORAGE_KEY,
  loadIntentOverrides,
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
