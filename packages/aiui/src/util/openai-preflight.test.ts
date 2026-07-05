import { describe, expect, it, vi } from "vitest";
import {
  type OpenAiKeyStatus,
  openAiPreflightMessage,
  preflightOpenAiKey,
} from "./openai-preflight";

/** A fetch stub that resolves with a given HTTP status (body is never read). */
function fetchWithStatus(status: number): typeof fetch {
  return vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
}

describe("preflightOpenAiKey", () => {
  it("reports 'missing' with no key in the environment, never calling fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const status = await preflightOpenAiKey({ env: {}, fetchImpl });
    expect(status).toBe("missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports 'unverified' for a present key when verify is off, never calling fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const status = await preflightOpenAiKey({
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl,
      verify: false,
    });
    expect(status).toBe("unverified");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports 'valid' on a 200 from the models endpoint", async () => {
    const status = await preflightOpenAiKey({
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: fetchWithStatus(200),
    });
    expect(status).toBe("valid");
  });

  it("reports 'invalid' on a 401 (the stale-export case)", async () => {
    const status = await preflightOpenAiKey({
      env: { OPENAI_API_KEY: "sk-stale" },
      fetchImpl: fetchWithStatus(401),
    });
    expect(status).toBe("invalid");
  });

  it("reports 'invalid' on a 403", async () => {
    const status = await preflightOpenAiKey({
      env: { OPENAI_API_KEY: "sk-forbidden" },
      fetchImpl: fetchWithStatus(403),
    });
    expect(status).toBe("invalid");
  });

  it("reports 'unverified' on a 5xx — an unconfirmed key is not a condemned key", async () => {
    const status = await preflightOpenAiKey({
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: fetchWithStatus(500),
    });
    expect(status).toBe("unverified");
  });

  it("reports 'unverified' when the request throws (offline / DNS / abort)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.openai.com");
    }) as unknown as typeof fetch;
    const status = await preflightOpenAiKey({ env: { OPENAI_API_KEY: "sk-test" }, fetchImpl });
    expect(status).toBe("unverified");
  });

  it("reports 'unverified' when the check exceeds the timeout", async () => {
    // A fetch that respects the abort signal, so the timeout can cancel it.
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    const status = await preflightOpenAiKey({
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl,
      timeoutMs: 5,
    });
    expect(status).toBe("unverified");
  });

  it("sends the key as a bearer token to the models endpoint, and reads status only", async () => {
    const fetchImpl = vi.fn(async () => new Response("SHOULD-NOT-BE-READ", { status: 200 }));
    await preflightOpenAiKey({
      env: { OPENAI_API_KEY: "sk-secret" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-secret");
  });

  it("trims whitespace and treats a blank key as missing", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const status = await preflightOpenAiKey({ env: { OPENAI_API_KEY: "   " }, fetchImpl });
    expect(status).toBe("missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("openAiPreflightMessage", () => {
  it("says nothing for a valid key", () => {
    expect(openAiPreflightMessage("valid")).toBeNull();
  });

  it("tells a missing-key user where to set it and what degrades", () => {
    const msg = openAiPreflightMessage("missing");
    expect(msg?.level).toBe("warn");
    expect(msg?.detail).toContain("OPENAI_API_KEY");
    expect(msg?.detail).toContain("mock/off");
  });

  it("points an invalid key at the stale-export check", () => {
    const msg = openAiPreflightMessage("invalid");
    expect(msg?.level).toBe("warn");
    // The diagnostic the field-notes stale-export story calls for.
    expect(msg?.detail).toContain("stale shell export");
    expect(msg?.detail).toContain("echo $OPENAI_API_KEY | head -c 12");
  });

  it("frames an unverified key as not-yet-confirmed, not condemned", () => {
    const msg = openAiPreflightMessage("unverified");
    expect(msg?.level).toBe("note");
    expect(msg?.detail.toLowerCase()).toContain("unverified");
  });

  it("never leaks a key: no message interpolates a real-looking secret", () => {
    // The copy is static and takes only a status — it structurally can't echo a
    // key. Guard the illustrative `sk-…` placeholder doesn't become a real token.
    const realKeyLike = /sk-[A-Za-z0-9_]{8,}/;
    const statuses: OpenAiKeyStatus[] = ["valid", "invalid", "missing", "unverified"];
    for (const status of statuses) {
      const msg = openAiPreflightMessage(status);
      expect(msg?.detail ?? "").not.toMatch(realKeyLike);
    }
  });
});
