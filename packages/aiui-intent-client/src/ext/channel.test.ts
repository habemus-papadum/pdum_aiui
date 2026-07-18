import { afterEach, describe, expect, it, vi } from "vitest";
import { CDP_CHANNEL_TAG_KEY } from "./manifest";

/** A minimal chrome.storage.local over one plain object. */
function fakeStorage(initial: Record<string, unknown> = {}): Record<string, unknown> {
  const store: Record<string, unknown> = { ...initial };
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        },
        remove: async (key: string) => {
          delete store[key];
        },
      },
      onChanged: { addListener: () => {} },
    },
  });
  return store;
}

/** /health answers `ok:true` for the given ports; everything else is dead. */
function fakeHealth(livePorts: number[]): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    const port = Number(/127\.0\.0\.1:(\d+)\//.exec(url)?.[1]);
    if (livePorts.includes(port) && url.endsWith("/health")) {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    if (livePorts.includes(port) && url.includes("/debug/api/channels")) {
      return {
        ok: true,
        json: async () => ({ channels: livePorts.map((p) => ({ port: p, tag: `t${p}` })) }),
      } as Response;
    }
    throw new Error(`dead port ${port}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const load = () => import("./channel");

describe("discoverChannel: the pin outranks the ladder", () => {
  it("returns a live pinned port even when the CDP tag names another channel", async () => {
    fakeStorage({
      "aiui2.pinnedPort": 49317,
      [CDP_CHANNEL_TAG_KEY]: { port: 50660, browserUrl: "http://127.0.0.1:9", taggedAt: "t" },
    });
    fakeHealth([49317, 50660]);
    const { discoverChannel } = await load();
    expect(await discoverChannel()).toBe(49317);
  });

  it("clears a dead pin and falls through to the CDP tag", async () => {
    const store = fakeStorage({
      "aiui2.pinnedPort": 49317,
      [CDP_CHANNEL_TAG_KEY]: { port: 50660, browserUrl: "http://127.0.0.1:9", taggedAt: "t" },
    });
    fakeHealth([50660]);
    const { discoverChannel } = await load();
    expect(await discoverChannel()).toBe(50660);
    expect(store["aiui2.pinnedPort"]).toBeUndefined();
  });

  it("pinPort stores the pick and remembers it as a recent", async () => {
    const store = fakeStorage();
    const { pinPort } = await load();
    await pinPort(49317);
    expect(store["aiui2.pinnedPort"]).toBe(49317);
    expect(store["aiui2.recentPorts"]).toEqual([49317]);
  });
});
