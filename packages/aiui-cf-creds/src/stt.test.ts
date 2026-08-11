/**
 * stt.test.ts — both STT credential species, over stubs. Scribe: the broker
 * round-trip happens per call (single-use by construction — the API offers
 * nowhere to hold a token) and the route resolves against an optional broker
 * origin. Transcription: the minted secret carries the `transcription`-type
 * session config, model defaulted from the channel's proven default, the
 * type non-negotiable. Fixture values are invented (D2).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MintClient } from "./oracle";
import { DEFAULT_TRANSCRIPTION_MODEL, scribeConnectUrl, transcriptionKeySource } from "./stt";

const FIXTURE = {
  region: "xx-invented-1",
  identityProviderId: "idp_test_fixture",
  serviceAccountId: "user-test-fixture",
};

afterEach(() => {
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
});

describe("transcriptionKeySource", () => {
  function stubClient() {
    const calls: Array<Record<string, unknown>> = [];
    const client: MintClient = {
      realtime: {
        clientSecrets: {
          create: async (body) => {
            calls.push(body);
            return { value: "ek_test_fixture", expires_at: 1_999_999 };
          },
        },
      },
    };
    return { client, calls };
  }

  it("bakes a transcription session with the channel's default model", async () => {
    const { client, calls } = stubClient();
    const credential = await transcriptionKeySource({ ...FIXTURE, client }).credential({});
    expect(calls[0]?.session).toEqual({
      type: "transcription",
      audio: { input: { transcription: { model: DEFAULT_TRANSCRIPTION_MODEL } } },
    });
    expect(credential.source).toBe("cf-federation:transcription");
    expect(credential.ek).toBe("ek_test_fixture");
  });

  it("honours transcriptionModel and keeps the session type non-negotiable", async () => {
    const { client, calls } = stubClient();
    const source = transcriptionKeySource({
      ...FIXTURE,
      client,
      transcriptionModel: "whisper-test-model",
    });
    await source.credential({ type: "realtime", include: ["fixture.flag"] });
    expect(calls[0]?.session).toEqual({
      // The caller's stray type is overridden; its other keys survive. The
      // caller supplied no audio block, so the default (and its model) stands.
      type: "transcription",
      include: ["fixture.flag"],
      audio: { input: { transcription: { model: "whisper-test-model" } } },
    });
  });

  it("lets a caller-supplied audio block replace the default whole", async () => {
    const { client, calls } = stubClient();
    const audio = { input: { transcription: { model: "caller-model" }, format: "pcm" } };
    await transcriptionKeySource({ ...FIXTURE, client }).credential({ audio });
    expect(calls[0]?.session).toEqual({ type: "transcription", audio });
  });

  it("describes itself distinctly from the realtime source", () => {
    const { client } = stubClient();
    expect(transcriptionKeySource({ ...FIXTURE, client }).describe()).toBe(
      "cf-federation:transcription",
    );
  });
});
