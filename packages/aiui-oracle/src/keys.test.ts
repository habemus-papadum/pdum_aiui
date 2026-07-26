/**
 * KeySources: `ek_` passthrough vs mint-from-parent, the shared mint shape
 * (the exploration's verified wire form), and the paste slot's failure mode.
 */
import { describe, expect, it } from "vitest";
import { mintClientSecret, PASTED_KEY_STORAGE_KEY, pasteKeySource, staticKeySource } from "./keys";

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

const minted = () =>
  new Response(JSON.stringify({ value: "ek_minted", expires_at: 1234 }), { status: 200 });

describe("mintClientSecret", () => {
  it("POSTs the verified wire shape and returns value/expires_at", async () => {
    const { impl, calls } = fakeFetch(minted);
    const credential = await mintClientSecret(
      "sk-parent",
      { type: "realtime", model: "gpt-realtime-2.1" },
      { ttlSeconds: 1200, fetchImpl: impl },
    );
    expect(credential).toEqual({ ek: "ek_minted", expiresAt: 1234 });
    expect(calls[0].url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.expires_after).toEqual({ anchor: "created_at", seconds: 1200 });
    expect((body.session as { model: string }).model).toBe("gpt-realtime-2.1");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-parent",
    );
  });

  it("a non-2xx mint throws with the status in the message", async () => {
    const { impl } = fakeFetch(() => new Response("nope", { status: 401 }));
    await expect(mintClientSecret("sk-bad", {}, { fetchImpl: impl })).rejects.toThrow("401");
  });
});

describe("staticKeySource", () => {
  it("an ek_ passes through unminted", async () => {
    const { impl, calls } = fakeFetch(minted);
    const source = staticKeySource("ek_direct", { fetchImpl: impl });
    expect(await source.credential({})).toEqual({ ek: "ek_direct", expiresAt: 0 });
    expect(calls).toHaveLength(0);
  });

  it("a parent key mints", async () => {
    const { impl } = fakeFetch(minted);
    const source = staticKeySource("sk-parent", { fetchImpl: impl });
    expect((await source.credential({})).ek).toBe("ek_minted");
  });
});

describe("pasteKeySource", () => {
  it("reads the shared storage slot at credential time; empty is a loud error", async () => {
    const slot = new Map<string, string>();
    const storage = { getItem: (key: string) => slot.get(key) ?? null };
    const { impl } = fakeFetch(minted);
    const source = pasteKeySource(storage, { fetchImpl: impl });
    await expect(source.credential({})).rejects.toThrow("no key pasted");
    slot.set(PASTED_KEY_STORAGE_KEY, "ek_pasted");
    expect((await source.credential({})).ek).toBe("ek_pasted");
  });
});
