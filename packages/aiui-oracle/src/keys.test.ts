/**
 * KeySources: `ek_` passthrough vs mint-from-parent, the shared mint shape
 * (the exploration's verified wire form), and the paste slot's failure mode.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cachingKeySource,
  chainKeySource,
  devKeySource,
  mintClientSecret,
  PASTED_KEY_STORAGE_KEY,
  pasteKeySource,
  standardKeySources,
  staticKeySource,
} from "./keys";

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

describe("chainKeySource — paste trumps, mint is the fallback", () => {
  it("first source to produce wins; a refusing source falls through; all refusing is loud", async () => {
    const slot = new Map<string, string>();
    const storage = { getItem: (key: string) => slot.get(key) ?? null };
    const { impl } = fakeFetch(minted);
    const chain = chainKeySource([
      pasteKeySource(storage, { fetchImpl: impl }),
      {
        describe: () => "fallback",
        credential: async () => ({ ek: "ek_fallback", expiresAt: 0 }),
      },
    ]);
    // Nothing pasted → the fallback answers.
    expect((await chain.credential({})).ek).toBe("ek_fallback");
    // Pasted → trumps.
    slot.set(PASTED_KEY_STORAGE_KEY, "ek_pasted");
    expect((await chain.credential({})).ek).toBe("ek_pasted");
    // Everything refusing → every refusal named.
    const dead = chainKeySource([
      { describe: () => "a", credential: async () => Promise.reject(new Error("nope-a")) },
      { describe: () => "b", credential: async () => Promise.reject(new Error("nope-b")) },
    ]);
    await expect(dead.credential({})).rejects.toThrow(/nope-a.*nope-b/);
  });
});

describe("cachingKeySource — reuse until the TTL margin", () => {
  it("mints once and reuses while the credential stays clear of the margin", async () => {
    let mints = 0;
    const inner = {
      describe: () => "mint",
      credential: async () => {
        mints += 1;
        return { ek: `ek_${mints}`, expiresAt: Date.now() / 1000 + 3600 };
      },
    };
    const cached = cachingKeySource(inner);
    expect((await cached.credential({})).ek).toBe("ek_1");
    expect((await cached.credential({})).ek).toBe("ek_1"); // reused
    expect(mints).toBe(1);
  });

  it("a near-expiry held credential is replaced", async () => {
    let mints = 0;
    const inner = {
      describe: () => "mint",
      credential: async () => {
        mints += 1;
        // Every mint is already inside the margin → never cacheable.
        return { ek: `ek_${mints}`, expiresAt: Date.now() / 1000 + 10 };
      },
    };
    const cached = cachingKeySource(inner);
    await cached.credential({});
    await cached.credential({});
    expect(mints).toBe(2);
  });

  it("unknown expiry (a pasted ek_) is never cached", async () => {
    let mints = 0;
    const inner = {
      describe: () => "static",
      credential: async () => {
        mints += 1;
        return { ek: "ek_x", expiresAt: 0 };
      },
    };
    const cached = cachingKeySource(inner);
    await cached.credential({});
    await cached.credential({});
    expect(mints).toBe(2);
  });
});

describe("devKeySource + standardKeySources — the three flows in the decided order", () => {
  const global = globalThis as Record<string, unknown>;
  const injectDevKeys = (keys: Record<string, string>) => {
    global.__AIUI__ = { v: 1, devKeys: keys };
  };
  afterEach(() => {
    delete global.__AIUI__;
  });

  it("reads __AIUI__.devKeys (the aiui plugin's seed); absent is a refusal, not a hang", async () => {
    await expect(devKeySource().credential({})).rejects.toThrow("dev key");
    injectDevKeys({ openai: "ek_injected" });
    const credential = await devKeySource().credential({});
    expect(credential.ek).toBe("ek_injected");
    expect(credential.source).toBe("dev-key:openai");
    // Vendor-keyed: a gemini request refuses when only openai was seeded.
    await expect(devKeySource("gemini").credential({})).rejects.toThrow("gemini");
  });

  it("paste trumps dev-key; dev-key covers the no-mint static app; mint only when configured", async () => {
    const slot = new Map<string, string>();
    const storage = { getItem: (key: string) => slot.get(key) ?? null };
    injectDevKeys({ openai: "ek_injected" });

    // No mintUrl (a purely static app): dev key answers in dev.
    const noMint = standardKeySources({ storage });
    expect((await noMint.credential({})).source).toBe("dev-key:openai");
    // Pasting trumps it.
    slot.set(PASTED_KEY_STORAGE_KEY, "ek_pasted");
    expect((await noMint.credential({})).source).toBe("paste-key");

    // No paste, no dev key (a deployed app WITH a minter): mint runs.
    slot.delete(PASTED_KEY_STORAGE_KEY);
    delete global.__AIUI__;
    const { impl } = fakeFetch(minted);
    const withMint = standardKeySources({
      storage,
      mintUrl: "http://mint.test/mint",
      mint: { fetchImpl: impl },
    });
    expect((await withMint.credential({})).source).toBe("mint:http://mint.test/mint");

    // And when NO mint endpoint exists (the purely static app, deployed):
    // everything refuses loudly, each reason named.
    const noneLeft = standardKeySources({ storage });
    await expect(noneLeft.credential({})).rejects.toThrow(/paste-key.*dev-key/);
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
