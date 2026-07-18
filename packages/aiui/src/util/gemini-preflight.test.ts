import type { OpenAiKeyStatus } from "@habemus-papadum/aiui-claude-channel";
import { describe, expect, it, vi } from "vitest";
import { geminiPreflightMessage, preflightGeminiKey } from "./gemini-preflight";

/** A fetch stub that resolves with a given HTTP status (body is never read). */
function fetchWithStatus(status: number): typeof fetch {
  return vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
}

describe("preflightGeminiKey", () => {
  it("reports 'missing' with no key in the environment, never calling fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const status = await preflightGeminiKey({ env: {}, fetchImpl });
    expect(status).toBe("missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports 'unverified' for a present key when verify is off, never calling fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const status = await preflightGeminiKey({
      env: { GEMINI_API_KEY: "gm-test" },
      fetchImpl,
      verify: false,
    });
    expect(status).toBe("unverified");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports 'valid' on a 200 from the models endpoint", async () => {
    const status = await preflightGeminiKey({
      env: { GEMINI_API_KEY: "gm-test" },
      fetchImpl: fetchWithStatus(200),
    });
    expect(status).toBe("valid");
  });

  it("reports 'invalid' on 400/401/403 (Gemini rejects bad keys with any of them)", async () => {
    for (const code of [400, 401, 403]) {
      const status = await preflightGeminiKey({
        env: { GEMINI_API_KEY: "gm-stale" },
        fetchImpl: fetchWithStatus(code),
      });
      expect(status).toBe("invalid");
    }
  });

  it("reports 'unverified' on a 5xx — an unconfirmed key is not a condemned key", async () => {
    const status = await preflightGeminiKey({
      env: { GEMINI_API_KEY: "gm-test" },
      fetchImpl: fetchWithStatus(500),
    });
    expect(status).toBe("unverified");
  });

  it("reports 'unverified' when the request throws (offline / DNS / abort)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND generativelanguage.googleapis.com");
    }) as unknown as typeof fetch;
    const status = await preflightGeminiKey({ env: { GEMINI_API_KEY: "gm-test" }, fetchImpl });
    expect(status).toBe("unverified");
  });

  it("sends the key on the query string (Gemini's auth shape), reading status only", async () => {
    const fetchImpl = vi.fn(async () => new Response("SHOULD-NOT-BE-READ", { status: 200 }));
    await preflightGeminiKey({
      env: { GEMINI_API_KEY: "gm-secret" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models?key=gm-secret");
  });

  it("trims whitespace and treats a blank key as missing", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const status = await preflightGeminiKey({ env: { GEMINI_API_KEY: "   " }, fetchImpl });
    expect(status).toBe("missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("geminiPreflightMessage", () => {
  it("says nothing for a valid key", () => {
    expect(geminiPreflightMessage("valid")).toBeNull();
  });

  it("treats a missing key as a note (only the realtime tier needs it)", () => {
    const msg = geminiPreflightMessage("missing");
    expect(msg?.level).toBe("note");
    expect(msg?.detail).toContain("GEMINI_API_KEY");
    expect(msg?.title).toContain("realtime");
  });

  it("warns on an invalid key and points at the stale-export check", () => {
    const msg = geminiPreflightMessage("invalid");
    expect(msg?.level).toBe("warn");
    expect(msg?.detail).toContain("stale shell export");
    expect(msg?.detail).toContain("echo $GEMINI_API_KEY | head -c 8");
  });

  it("frames an unverified key as not-yet-confirmed, not condemned", () => {
    const msg = geminiPreflightMessage("unverified");
    expect(msg?.level).toBe("note");
    expect(msg?.detail.toLowerCase()).toContain("unverified");
  });

  it("never leaks a key: no message interpolates a real-looking secret", () => {
    const realKeyLike = /AIza[A-Za-z0-9_-]{8,}/;
    const statuses: OpenAiKeyStatus[] = ["valid", "invalid", "missing", "unverified"];
    for (const status of statuses) {
      const msg = geminiPreflightMessage(status);
      expect(msg?.detail ?? "").not.toMatch(realKeyLike);
    }
  });
});
