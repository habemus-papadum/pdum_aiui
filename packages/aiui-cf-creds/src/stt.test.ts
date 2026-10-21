/** Fresh ElevenLabs credentials from browser keys or a broker. */
import { browserVendorKey } from "@habemus-papadum/aiui-viz/vendor-keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scribeConnectUrl, standardScribeConnectUrl } from "./stt";

vi.mock("@habemus-papadum/aiui-viz/vendor-keys", () => ({ browserVendorKey: vi.fn() }));

afterEach(() => {
  vi.mocked(browserVendorKey).mockReset();
  vi.unstubAllGlobals();
});

/** Stub the broker route: one fresh single-use token per fetch. */
function stubScribeBroker() {
  let minted = 0;
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    minted += 1;
    seen.push({ url, init });
    return new Response(
      JSON.stringify({
        token: `sutkn_fixture_${minted}`,
        expiration: new Date(Date.now() + 900_000).toISOString(),
      }),
      { status: 200 },
    );
  });
  return seen;
}

describe("scribeConnectUrl", () => {
  it("fetches from the conventional same-origin route and returns the socket URL", async () => {
    const seen = stubScribeBroker();
    const url = await scribeConnectUrl();
    expect(seen[0]?.url).toBe("/api/credentials/elevenlabs");
    // The Access cookie is the auth — the kit must send it.
    expect(seen[0]?.init?.credentials).toBe("include");
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("wss:");
    expect(parsed.searchParams.get("token")).toBe("sutkn_fixture_1");
    expect(parsed.searchParams.get("model_id")).toBe("scribe_v2_realtime");
  });

  it("resolves the route against a broker origin and passes socket options through", async () => {
    const seen = stubScribeBroker();
    const url = await scribeConnectUrl({
      brokerUrl: "https://broker.example.test",
      audioFormat: "pcm_24000",
      includeTimestamps: true,
    });
    expect(seen[0]?.url).toBe("https://broker.example.test/api/credentials/elevenlabs");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("audio_format")).toBe("pcm_24000");
    expect(parsed.searchParams.get("include_timestamps")).toBe("true");
  });

  it("is one call = one connect: every call mints a fresh token", async () => {
    const seen = stubScribeBroker();
    const first = await scribeConnectUrl();
    const second = await scribeConnectUrl();
    expect(seen).toHaveLength(2);
    expect(new URL(first).searchParams.get("token")).toBe("sutkn_fixture_1");
    expect(new URL(second).searchParams.get("token")).toBe("sutkn_fixture_2");
  });

  it("rides the grant path selection: ?grant_path= on the route, same-origin or against a broker", async () => {
    const seen = stubScribeBroker();
    await scribeConnectUrl({ grantPath: "app-fixture" });
    await scribeConnectUrl({ brokerUrl: "https://broker.example.test", grantPath: "app-fixture" });
    expect(seen[0]?.url).toBe("/api/credentials/elevenlabs?grant_path=app-fixture");
    expect(seen[1]?.url).toBe(
      "https://broker.example.test/api/credentials/elevenlabs?grant_path=app-fixture",
    );
  });
});

describe("standardScribeConnectUrl", () => {
  it("mints freshly from the shared browser key for every connection", async () => {
    vi.mocked(browserVendorKey).mockReturnValue("fixture-elevenlabs-key");
    const seen = stubScribeBroker();
    const first = await standardScribeConnectUrl();
    const second = await standardScribeConnectUrl();
    expect(seen).toHaveLength(2);
    expect(seen[0].url).toBe("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe");
    expect(seen[0].init?.headers).toEqual({ "xi-api-key": "fixture-elevenlabs-key" });
    expect(new URL(first).searchParams.get("token")).not.toBe(
      new URL(second).searchParams.get("token"),
    );
  });
  it("uses an explicit key callback instead of browser storage", async () => {
    const seen = stubScribeBroker();
    await standardScribeConnectUrl({ apiKey: () => "explicit-fixture", audioFormat: "pcm_24000" });
    expect(seen[0].init?.headers).toEqual({ "xi-api-key": "explicit-fixture" });
    expect(browserVendorKey).not.toHaveBeenCalled();
  });
  it("falls back to a configured broker and reports missing credentials", async () => {
    const seen = stubScribeBroker();
    await standardScribeConnectUrl({ brokerUrl: "https://creds.example.test", grantPath: "app" });
    expect(seen[0].url).toBe(
      "https://creds.example.test/api/credentials/elevenlabs?grant_path=app",
    );
    await expect(standardScribeConnectUrl()).rejects.toThrow("Add an ElevenLabs key");
  });
});
