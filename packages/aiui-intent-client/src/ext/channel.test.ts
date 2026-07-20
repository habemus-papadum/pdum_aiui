import { afterEach, describe, expect, it, vi } from "vitest";
import { CDP_DRIVER_TAG_PREFIX } from "./manifest";

/** A fresh roster entry for `port` (fresh = inside the staleness window). */
const driverEntry = (port: number) => ({
  [`${CDP_DRIVER_TAG_PREFIX}${port}`]: {
    port,
    browserUrl: "http://127.0.0.1:9",
    taggedAt: new Date().toISOString(),
  },
});

/** A minimal chrome.storage.local over one plain object. */
function fakeStorage(initial: Record<string, unknown> = {}): Record<string, unknown> {
  const store: Record<string, unknown> = { ...initial };
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        // `get(null)` = the whole store (the roster read uses it).
        get: async (key: string | null) => (key === null ? { ...store } : { [key]: store[key] }),
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
      ...driverEntry(50660),
    });
    fakeHealth([49317, 50660]);
    const { discoverChannel } = await load();
    expect(await discoverChannel()).toBe(49317);
  });

  it("clears a dead pin and falls through to the CDP tag", async () => {
    const store = fakeStorage({
      "aiui2.pinnedPort": 49317,
      ...driverEntry(50660),
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

describe("listChannels tells 'nothing running' apart from 'native messaging broken'", () => {
  /** chrome with storage AND a scriptable native host. */
  function fakeChromeWithNative(
    sendNativeMessage: (host: string, msg: unknown) => Promise<unknown>,
  ): void {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {},
        },
        onChanged: { addListener: () => {} },
      },
      runtime: { sendNativeMessage },
    });
  }

  it("a working host with an empty registry is a CLEAN empty listing (run `aiui claude`)", async () => {
    fakeChromeWithNative(async () => ({ ok: true, protocol: 2, channels: [] }));
    const { listChannels } = await load();
    const listing = await listChannels();
    expect(listing.channels).toEqual([]);
    expect(listing.nativeHostError).toBeUndefined();
  });

  it("an OUTDATED host (old/absent protocol) is an error, not a silent list", async () => {
    fakeChromeWithNative(async () => ({ ok: true, channels: [{ port: 4200 }] }));
    const { listChannels } = await load();
    const listing = await listChannels();
    expect(listing.nativeHostError).toMatch(/outdated .*protocol 1 < 2/);
  });

  it("a missing host carries Chrome's error (install-native-host is the remedy)", async () => {
    fakeChromeWithNative(async () => {
      throw new Error("Specified native messaging host not found.");
    });
    const { listChannels } = await load();
    const listing = await listChannels();
    expect(listing.channels).toEqual([]);
    expect(listing.nativeHostError).toBe("Specified native messaging host not found.");
  });

  it("a broken host still lists via the mirror fallback — but keeps the error", async () => {
    fakeChromeWithNative(async () => {
      throw new Error("Native host has exited.");
    });
    fakeHealth([4100]);
    const { listChannels } = await load();
    const listing = await listChannels(4100);
    expect(listing.channels.map((c) => c.port)).toEqual([4100]);
    expect(listing.nativeHostError).toBe("Native host has exited.");
  });

  it("probeNativeHost reports ok / error for the boot-time diagnosis", async () => {
    fakeChromeWithNative(async () => ({ ok: true, protocol: 2, channels: [{ port: 4200 }] }));
    const one = await load();
    expect(await one.probeNativeHost()).toEqual({ ok: true, channels: [{ port: 4200 }] });

    vi.resetModules();
    fakeChromeWithNative(async () => {
      throw new Error("Specified native messaging host not found.");
    });
    const two = await load();
    expect(await two.probeNativeHost()).toEqual({
      ok: false,
      error: "Specified native messaging host not found.",
    });
  });
});
