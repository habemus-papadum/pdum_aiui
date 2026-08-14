/**
 * oracle.test.ts — the mint mapping and the KeySource contract. The
 * federation chain itself (broker → STS → SDK exchange) is the kit's,
 * verified live 2026-08-07; what THIS package owns is the mint call's body
 * and the mapping onto OracleCredential — pinned here over an injected
 * structural client. All identity values are invented fixtures (D2).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { federatedKeySource, type MintClient } from "./oracle";

// The keyed lane's seam: the kit's createBrokeredOpenAI is what turns a key
// into a configured client (its own tests own that behavior); THIS package
// owns handing it the right route and using what comes back. Everything else
// in the module stays real.
const brokered = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  client: undefined as MintClient | undefined,
  failOnce: undefined as Error | undefined,
}));
vi.mock("@habemus-papadum/cf-creds-openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@habemus-papadum/cf-creds-openai")>();
  return {
    ...actual,
    createBrokeredOpenAI: async (options: Record<string, unknown> = {}) => {
      brokered.calls.push(options);
      if (brokered.failOnce !== undefined) {
        const error = brokered.failOnce;
        brokered.failOnce = undefined;
        throw error;
      }
      return { client: brokered.client, manager: {} };
    },
  };
});

/** A capturing stub of the one SDK surface the mint uses. */
function stubClient(reply?: { value?: unknown; expires_at?: unknown }) {
  const calls: Array<Record<string, unknown>> = [];
  const client: MintClient = {
    realtime: {
      clientSecrets: {
        create: async (body) => {
          calls.push(body);
          return (reply ?? { value: "ek_test_fixture", expires_at: 1_999_999 }) as {
            value: string;
            expires_at: number;
          };
        },
      },
    },
  };
  return { client, calls };
}

const FIXTURE = {
  region: "xx-invented-1",
  identityProviderId: "idp_test_fixture",
  serviceAccountId: "user-test-fixture",
};

describe("federatedKeySource", () => {
  it("mints with the default TTL and forwards the session verbatim", async () => {
    const { client, calls } = stubClient();
    const source = federatedKeySource({ ...FIXTURE, client });
    const session = { type: "realtime", model: "gpt-realtime-test" };

    const credential = await source.credential(session);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      expires_after: { anchor: "created_at", seconds: 600 },
      session,
    });
    expect(credential).toEqual({
      ek: "ek_test_fixture",
      expiresAt: 1_999_999,
      source: "cf-federation",
    });
  });

  it("honours expiresAfterSeconds", async () => {
    const { client, calls } = stubClient();
    const source = federatedKeySource({ ...FIXTURE, client, expiresAfterSeconds: 42 });
    await source.credential({});
    expect(calls[0]?.expires_after).toEqual({ anchor: "created_at", seconds: 42 });
  });

  it("describes itself for the ledger", () => {
    const { client } = stubClient();
    expect(federatedKeySource({ ...FIXTURE, client }).describe()).toBe("cf-federation");
  });

  it("refuses an empty mint loudly, and maps an unknown expiry to 0", async () => {
    const empty = stubClient({ value: "", expires_at: 1 });
    await expect(
      federatedKeySource({ ...FIXTURE, client: empty.client }).credential({}),
    ).rejects.toThrow(/no client secret/);

    const unstamped = stubClient({ value: "ek_ok", expires_at: undefined });
    const credential = await federatedKeySource({
      ...FIXTURE,
      client: unstamped.client,
    }).credential({});
    expect(credential.expiresAt).toBe(0);
  });
});

describe("federatedKeySource — the key contract", () => {
  beforeEach(() => {
    brokered.calls.length = 0;
    brokered.client = undefined;
    brokered.failOnce = undefined;
  });

  it("builds the client from nothing but the app's own key", async () => {
    const { client, calls } = stubClient();
    brokered.client = client;
    const source = federatedKeySource({
      key: "app-fixture",
      brokerUrl: "https://creds.example.test",
    });

    const credential = await source.credential({ type: "realtime" });

    expect(brokered.calls).toEqual([
      { url: "https://creds.example.test/api/credentials/openai?key=app-fixture" },
    ]);
    expect(calls).toHaveLength(1);
    expect(credential.ek).toBe("ek_test_fixture");
  });

  it("stays same-origin relative when no brokerUrl is given", async () => {
    brokered.client = stubClient().client;
    await federatedKeySource({ key: "app-fixture" }).credential({});
    expect(brokered.calls[0]).toEqual({ url: "/api/credentials/openai?key=app-fixture" });
  });

  it("without key or the explicit trio, fails lazily with a clear error", async () => {
    // Construction must stay cheap and silent (a chained source that never
    // wins); the error surfaces only when the source is actually asked.
    const source = federatedKeySource({});
    expect(brokered.calls).toHaveLength(0);
    await expect(source.credential({})).rejects.toThrow(
      /needs `key`.*region \+ identityProviderId \+ serviceAccountId/,
    );
  });

  it("forgets a failed build so a transient broker error does not wedge the source", async () => {
    brokered.failOnce = new Error("transient broker failure");
    const source = federatedKeySource({ key: "app-fixture" });
    await expect(source.credential({})).rejects.toThrow(/transient broker failure/);

    brokered.client = stubClient().client;
    const credential = await source.credential({});
    expect(credential.ek).toBe("ek_test_fixture");
    expect(brokered.calls).toHaveLength(2);
  });

  it("builds once across concurrent mints", async () => {
    const { client, calls } = stubClient();
    brokered.client = client;
    const source = federatedKeySource({ key: "app-fixture" });
    await Promise.all([source.credential({}), source.credential({})]);
    expect(brokered.calls).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});
