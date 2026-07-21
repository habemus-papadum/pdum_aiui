import type { ResolvedVendorKey, ResolvedVendorKeys } from "@habemus-papadum/aiui-util";
import { describe, expect, it, vi } from "vitest";
import {
  preflightVendorKeys,
  reportVendorKeyPreflight,
  vendorKeyPreflightMessage,
  verifyVendorKey,
} from "./vendor-key-preflight";

/** A fetch stub that resolves with a given HTTP status (body is never read). */
function fetchWithStatus(status: number): typeof fetch {
  return vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
}

/** Round-one output with every provider `missing`, overridable per test. */
function resolved(overrides: Partial<ResolvedVendorKeys> = {}): ResolvedVendorKeys {
  const missing = (provider: "openai" | "gemini" | "elevenlabs", envVar: string, label: string) =>
    ({ provider, envVar, label, source: "missing" }) as ResolvedVendorKey;
  return {
    openai: missing("openai", "OPENAI_API_KEY", "OpenAI"),
    gemini: missing("gemini", "GEMINI_API_KEY", "Gemini"),
    elevenlabs: missing("elevenlabs", "ELEVEN_LABS_API_KEY", "ElevenLabs"),
    ...overrides,
  };
}

function found(
  provider: "openai" | "gemini" | "elevenlabs",
  source: "env" | "vault",
  value: string,
): ResolvedVendorKey {
  const envVar = {
    openai: "OPENAI_API_KEY",
    gemini: "GEMINI_API_KEY",
    elevenlabs: "ELEVEN_LABS_API_KEY",
  }[provider];
  const label = { openai: "OpenAI", gemini: "Gemini", elevenlabs: "ElevenLabs" }[provider];
  return { provider, envVar, label, source, value };
}

describe("verifyVendorKey — one vendor, one question", () => {
  it("sends each provider's own auth shape", async () => {
    const fetchImpl = fetchWithStatus(200);
    await verifyVendorKey("openai", "sk-test", { fetchImpl });
    await verifyVendorKey("gemini", "g-test", { fetchImpl });
    await verifyVendorKey("elevenlabs", "el-test", { fetchImpl });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0]).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer sk-test" });
    expect(calls[1]?.[0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?key=g-test",
    );
    expect(calls[1]?.[1]?.headers).toBeUndefined();
    expect(calls[2]?.[0]).toBe("https://api.elevenlabs.io/v1/user");
    expect(calls[2]?.[1]?.headers).toEqual({ "xi-api-key": "el-test" });
  });

  it("2xx → valid; condemning statuses → invalid; the rest → unverified", async () => {
    expect(await verifyVendorKey("openai", "k", { fetchImpl: fetchWithStatus(200) })).toBe("valid");
    expect(await verifyVendorKey("openai", "k", { fetchImpl: fetchWithStatus(401) })).toBe(
      "invalid",
    );
    expect(await verifyVendorKey("openai", "k", { fetchImpl: fetchWithStatus(403) })).toBe(
      "invalid",
    );
    // OpenAI's 400 is a malformed REQUEST, not a condemned key.
    expect(await verifyVendorKey("openai", "k", { fetchImpl: fetchWithStatus(400) })).toBe(
      "unverified",
    );
    // Gemini answers 400/401/403 depending on how the key is malformed.
    expect(await verifyVendorKey("gemini", "k", { fetchImpl: fetchWithStatus(400) })).toBe(
      "invalid",
    );
    expect(await verifyVendorKey("openai", "k", { fetchImpl: fetchWithStatus(500) })).toBe(
      "unverified",
    );
    expect(await verifyVendorKey("openai", "k", { fetchImpl: fetchWithStatus(429) })).toBe(
      "unverified",
    );
  });

  it("ElevenLabs 401s are classified by body, not condemned by status", async () => {
    // Both shapes measured 2026-07-21: a RESTRICTED key (scoped to
    // speech-to-text, all Scribe needs) 401s `missing_permissions` on every
    // introspection endpoint — an authenticated response, so the key is real.
    const with401Body = (status: string): typeof fetch =>
      vi.fn(
        async () => new Response(JSON.stringify({ detail: { status } }), { status: 401 }),
      ) as unknown as typeof fetch;
    expect(
      await verifyVendorKey("elevenlabs", "k", { fetchImpl: with401Body("invalid_api_key") }),
    ).toBe("invalid");
    expect(
      await verifyVendorKey("elevenlabs", "k", { fetchImpl: with401Body("missing_permissions") }),
    ).toBe("valid");
    // An unrecognized rejection shape: don't condemn what we can't identify.
    expect(
      await verifyVendorKey("elevenlabs", "k", { fetchImpl: with401Body("something-new") }),
    ).toBe("unverified");
    expect(await verifyVendorKey("elevenlabs", "k", { fetchImpl: fetchWithStatus(401) })).toBe(
      "unverified",
    );
  });

  it("network errors and timeouts are unverified, never thrown", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await verifyVendorKey("openai", "k", { fetchImpl: failing })).toBe("unverified");

    const hanging = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    expect(await verifyVendorKey("openai", "k", { fetchImpl: hanging, timeoutMs: 20 })).toBe(
      "unverified",
    );
  });
});

describe("preflightVendorKeys — validity over round one's resolution, nothing else", () => {
  it("verifies only FOUND keys; skip and missing report 'missing' without fetching", async () => {
    const fetchImpl = fetchWithStatus(200);
    const statuses = await preflightVendorKeys(
      resolved({
        openai: found("openai", "env", "sk-test"),
        gemini: { provider: "gemini", envVar: "GEMINI_API_KEY", label: "Gemini", source: "skip" },
      }),
      { fetchImpl },
    );
    expect(statuses).toEqual({ openai: "valid", gemini: "missing", elevenlabs: "missing" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("verify off (CI/non-interactive): found keys are 'unverified', no network", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const statuses = await preflightVendorKeys(
      resolved({ openai: found("openai", "vault", "sk-test") }),
      { verify: false, fetchImpl },
    );
    expect(statuses.openai).toBe("unverified");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a rejected key reports 'invalid' (the launch-failure signal)", async () => {
    const statuses = await preflightVendorKeys(
      resolved({ openai: found("openai", "vault", "sk-stale") }),
      { fetchImpl: fetchWithStatus(401) },
    );
    expect(statuses.openai).toBe("invalid");
  });
});

describe("vendorKeyPreflightMessage — copy per case", () => {
  it("valid keys and chosen skips are silent", () => {
    expect(vendorKeyPreflightMessage(found("openai", "env", "k"), "valid")).toBeNull();
    expect(
      vendorKeyPreflightMessage(
        { provider: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI", source: "skip" },
        "missing",
      ),
    ).toBeNull();
  });

  it("invalid is an error whose remedy matches where the key came from", () => {
    const env = vendorKeyPreflightMessage(found("openai", "env", "k"), "invalid");
    expect(env?.level).toBe("error");
    expect(env?.detail).toContain("stale shell export");
    expect(env?.detail).toContain("echo $OPENAI_API_KEY");

    const vault = vendorKeyPreflightMessage(found("elevenlabs", "vault", "k"), "invalid");
    expect(vault?.level).toBe("error");
    expect(vault?.detail).toContain("aiui keys set elevenlabs");
  });

  it("missing degrades: warn for the default-path providers, note for Gemini", () => {
    expect(vendorKeyPreflightMessage(resolved().openai, "missing")?.level).toBe("warn");
    expect(vendorKeyPreflightMessage(resolved().gemini, "missing")?.level).toBe("note");
    expect(vendorKeyPreflightMessage(resolved().elevenlabs, "missing")?.level).toBe("warn");
  });

  it("unverified notes only when a key was actually found", () => {
    expect(vendorKeyPreflightMessage(found("openai", "env", "k"), "unverified")?.level).toBe(
      "note",
    );
    expect(vendorKeyPreflightMessage(resolved().openai, "unverified")).toBeNull();
  });
});

describe("reportVendorKeyPreflight — the fatal verdict", () => {
  it("any invalid key is fatal; degradation alone is not", () => {
    const keys = resolved({ openai: found("openai", "env", "k") });
    expect(
      reportVendorKeyPreflight(keys, {
        openai: "invalid",
        gemini: "missing",
        elevenlabs: "missing",
      }).fatal,
    ).toBe(true);
    expect(
      reportVendorKeyPreflight(keys, {
        openai: "valid",
        gemini: "missing",
        elevenlabs: "missing",
      }).fatal,
    ).toBe(false);
  });
});
