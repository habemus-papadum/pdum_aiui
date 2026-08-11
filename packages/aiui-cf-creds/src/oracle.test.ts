/**
 * oracle.test.ts — the mint mapping and the KeySource contract. The
 * federation chain itself (broker → STS → SDK exchange) is the kit's,
 * verified live 2026-08-07; what THIS package owns is the mint call's body
 * and the mapping onto OracleCredential — pinned here over an injected
 * structural client. All identity values are invented fixtures (D2).
 */
import { describe, expect, it } from "vitest";
import { federatedKeySource, type MintClient } from "./oracle";

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
