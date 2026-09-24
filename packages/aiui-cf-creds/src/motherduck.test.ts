/**
 * motherduck.test.ts — the /motherduck composition over a scripted client and
 * a stubbed broker route (real kit code in between, no network, no wasm).
 * What must hold: the dev key wins when injected and no route is fetched;
 * the broker lane fetches the keyed conventional route (absolute under
 * `brokerUrl`) and builds with the minted token; params pass through and the
 * kit's read_only refusal surfaces at construction.
 */
import type { MotherDuckClient } from "@habemus-papadum/cf-creds-motherduck";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  brokerMotherDuckEngine,
  devMotherDuckEngine,
  devMotherDuckToken,
  standardMotherDuckEngine,
} from "./motherduck";

function fakeClient() {
  const creates: Array<Record<string, unknown>> = [];
  const client: MotherDuckClient = {
    MDConnection: {
      create: (params) => {
        creates.push(params as unknown as Record<string, unknown>);
        return { params } as never;
      },
    },
    getAsyncDuckDb: async () => ({ connect: async () => ({}) }) as never,
    terminateDuckDB: async () => {},
  };
  return { client, creates };
}

const withDevKey = (token?: string): unknown => ({
  __AIUI__: token === undefined ? {} : { devKeys: { motherduck: token } },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("devMotherDuckToken", () => {
  it("reads the plugin's seed and treats absence or blank as none", () => {
    expect(devMotherDuckToken(withDevKey("md_dev"))).toBe("md_dev");
    expect(devMotherDuckToken(withDevKey())).toBeUndefined();
    expect(devMotherDuckToken({ __AIUI__: { devKeys: { motherduck: "" } } })).toBeUndefined();
    expect(devMotherDuckToken({})).toBeUndefined();
  });
});

describe("devMotherDuckEngine", () => {
  it("builds with the injected token and the caller's params, fetching nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { client, creates } = fakeClient();
    const engine = devMotherDuckEngine(
      { client, params: { sessionName: "lab", customUserAgent: "lab/1" } },
      withDevKey("md_dev"),
    );

    await engine.ready();

    expect(creates).toEqual([{ sessionName: "lab", customUserAgent: "lab/1", mdToken: "md_dev" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses at construction when no dev key is injected", () => {
    const { client } = fakeClient();
    expect(() => devMotherDuckEngine({ client }, withDevKey())).toThrow(/devKeys.*motherduck/s);
  });
});

describe("brokerMotherDuckEngine", () => {
  it("fetches the keyed route under brokerUrl and builds with the minted token", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          token: "md_minted",
          serviceAccount: "reader",
          expiration: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 200 },
      );
    });
    const { client, creates } = fakeClient();
    const engine = brokerMotherDuckEngine({
      client,
      brokerUrl: "https://creds.example.test",
      key: "notes",
      params: { sessionName: "visitor" },
    });

    await engine.ready();

    expect(urls).toEqual(["https://creds.example.test/api/credentials/motherduck?key=notes"]);
    expect(creates).toEqual([{ sessionName: "visitor", mdToken: "md_minted" }]);
  });

  it("stays same-origin relative without brokerUrl, the key still riding", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({ token: "t", expiration: new Date(Date.now() + 3_600_000).toISOString() }),
        { status: 200 },
      );
    });
    const { client } = fakeClient();
    await brokerMotherDuckEngine({ client, key: "notes" }).ready();
    expect(urls).toEqual(["/api/credentials/motherduck?key=notes"]);
  });

  it("surfaces the kit's read_only refusal at construction", () => {
    const { client } = fakeClient();
    expect(() =>
      brokerMotherDuckEngine({ client, key: "notes", params: { accessMode: "read_only" } }),
    ).toThrow(/read_only/);
  });
});

describe("standardMotherDuckEngine", () => {
  it("prefers the dev key when injected, else the broker", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "md_minted",
            expiration: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const dev = fakeClient();
    await standardMotherDuckEngine(
      { client: dev.client, key: "notes" },
      withDevKey("md_dev"),
    ).ready();
    expect(dev.creates[0]?.mdToken).toBe("md_dev");
    expect(fetchMock).not.toHaveBeenCalled();

    const prod = fakeClient();
    await standardMotherDuckEngine({ client: prod.client, key: "notes" }, withDevKey()).ready();
    expect(prod.creates[0]?.mdToken).toBe("md_minted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("motherDuckRunner", () => {
  it("answers columnar with DuckDB's own type names, values rendered plain", async () => {
    const { motherDuckRunner } = await import("./motherduck");
    const ts = { toString: () => "2026-09-24 10:00:00" };
    const connection = {
      evaluateQuery: async (sql: string) => ({
        data: {
          deduplicatedColumnNames: () => ["n", "when", "big", "tag"],
          columnType: (i: number) => ({
            toString: () => ["BIGINT", "TIMESTAMP", "HUGEINT", "VARCHAR"][i],
          }),
          toRows: () => [
            { n: 42n, when: ts, big: 2n ** 70n, tag: "x", _sql: sql },
            { n: 7n, when: null, big: 1n, tag: "y", _sql: sql },
          ],
        },
      }),
    };
    const runner = motherDuckRunner(connection as never);
    const result = await runner.query("SELECT …");
    expect(result.columns).toEqual(["n", "when", "big", "tag"]);
    expect(result.types).toEqual(["BIGINT", "TIMESTAMP", "HUGEINT", "VARCHAR"]);
    expect(result.rows).toEqual([
      [42, "2026-09-24 10:00:00", (2n ** 70n).toString(), "x"],
      [7, null, 1, "y"],
    ]);
    expect(runner.cancel).toBeUndefined();
  });
});
