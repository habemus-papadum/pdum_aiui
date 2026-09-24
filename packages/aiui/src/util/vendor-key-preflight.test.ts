import type {
  ResolvedVendorKey,
  ResolvedVendorKeys,
  VendorProvider,
} from "@habemus-papadum/aiui-util";
import { describe, expect, it } from "vitest";
import { vendorKeyPreflightMessage, vendorKeyStatuses } from "./vendor-key-preflight";

/** Round-one output with every provider `missing`, overridable per test. */
function resolved(overrides: Partial<ResolvedVendorKeys> = {}): ResolvedVendorKeys {
  const missing = (provider: VendorProvider, envVar: string, label: string) =>
    ({ provider, envVar, label, source: "missing" }) as ResolvedVendorKey;
  return {
    openai: missing("openai", "OPENAI_API_KEY", "OpenAI"),
    gemini: missing("gemini", "GEMINI_API_KEY", "Gemini"),
    elevenlabs: missing("elevenlabs", "ELEVEN_LABS_API_KEY", "ElevenLabs"),
    motherduck: missing("motherduck", "MOTHERDUCK_BROWSER_TOKEN", "MotherDuck"),
    ...overrides,
  };
}

function found(
  provider: VendorProvider,
  source: "env" | "vault",
  value: string,
): ResolvedVendorKey {
  const envVar = {
    openai: "OPENAI_API_KEY",
    gemini: "GEMINI_API_KEY",
    elevenlabs: "ELEVEN_LABS_API_KEY",
    motherduck: "MOTHERDUCK_BROWSER_TOKEN",
  }[provider];
  const label = {
    openai: "OpenAI",
    gemini: "Gemini",
    elevenlabs: "ElevenLabs",
    motherduck: "MotherDuck",
  }[provider];
  return { provider, envVar, label, source, value };
}

describe("vendorKeyStatuses — presence over round one's resolution, nothing else", () => {
  it("a resolved value is 'present'; skip and missing are 'missing'", () => {
    const statuses = vendorKeyStatuses(
      resolved({
        openai: found("openai", "env", "sk-test"),
        gemini: { provider: "gemini", envVar: "GEMINI_API_KEY", label: "Gemini", source: "skip" },
      }),
    );
    expect(statuses).toEqual({
      openai: "present",
      gemini: "missing",
      elevenlabs: "missing",
      motherduck: "missing",
    });
  });

  it("a blank value is not a key", () => {
    expect(vendorKeyStatuses(resolved({ openai: found("openai", "vault", "  ") })).openai).toBe(
      "missing",
    );
  });
});

describe("vendorKeyPreflightMessage — copy per case", () => {
  it("an opt-in provider is silent even when missing — the app that needs it warns", () => {
    expect(vendorKeyPreflightMessage(resolved().motherduck)).toBeNull();
  });

  it("present keys and chosen skips are silent", () => {
    expect(vendorKeyPreflightMessage(found("openai", "env", "k"))).toBeNull();
    expect(vendorKeyPreflightMessage(found("elevenlabs", "vault", "k"))).toBeNull();
    expect(
      vendorKeyPreflightMessage({
        provider: "openai",
        envVar: "OPENAI_API_KEY",
        label: "OpenAI",
        source: "skip",
      }),
    ).toBeNull();
  });

  it("missing degrades: warn for the default-path providers, note for Gemini", () => {
    expect(vendorKeyPreflightMessage(resolved().openai)?.level).toBe("warn");
    expect(vendorKeyPreflightMessage(resolved().gemini)?.level).toBe("note");
    expect(vendorKeyPreflightMessage(resolved().elevenlabs)?.level).toBe("warn");
  });

  it("degradation copy names the fix for where the key would come from", () => {
    const openai = vendorKeyPreflightMessage(resolved().openai);
    expect(openai?.detail).toContain("aiui keys set openai");
    expect(openai?.detail).toContain("OPENAI_API_KEY");
    const elevenlabs = vendorKeyPreflightMessage(resolved().elevenlabs);
    expect(elevenlabs?.detail).toContain("aiui keys set elevenlabs");
  });
});
