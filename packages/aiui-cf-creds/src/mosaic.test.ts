/**
 * mosaic.test.ts — the /mosaic wiring over a fake base connector and a
 * stubbed broker route (real kit code in between, no network). What must
 * hold: credentials are installed BEFORE the app's query reaches the base,
 * unchanged credentials don't reinstall, rotation reinstalls, and the
 * kit-observability options pass through. Credential values are invented
 * fixtures (D2).
 */
import type { Connector } from "@uwdata/mosaic-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerConnector } from "./mosaic";

type Captured = { type?: string; sql: string };

function fakeBase(options: { rejectCreateSecret?: boolean } = {}) {
  const queries: Captured[] = [];
  const base = {
    query: async (request: Captured) => {
      queries.push(request);
      if (options.rejectCreateSecret && /CREATE OR REPLACE SECRET/.test(request.sql)) {
        throw new Error("this duckdb build rejects CREATE SECRET");
      }
      return "fixture-result";
    },
  } as unknown as Connector;
  return { base, queries };
}

function stubAwsBroker(initial = "AKIAFIXTURE1") {
  let accessKeyId = initial;
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return new Response(
      JSON.stringify({
        accessKeyId,
        secretAccessKey: "invented-secret",
        sessionToken: "invented-session",
        expiration: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      { status: 200 },
    );
  });
  return { urls, rotate: (next: string) => (accessKeyId = next) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("brokerConnector", () => {
  it("installs credentials from the conventional route before the first query", async () => {
    const { base, queries } = fakeBase();
    const { urls } = stubAwsBroker();
    const connector = brokerConnector(base, { region: "xx-invented-1" });

    const result = await connector.query({ type: "arrow", sql: "SELECT 1" } as never);

    expect(result).toBe("fixture-result");
    expect(urls).toEqual(["/api/credentials/aws"]);
    expect(queries).toHaveLength(2);
    expect(queries[0]?.type).toBe("exec");
    expect(queries[0]?.sql).toContain("CREATE OR REPLACE SECRET");
    expect(queries[0]?.sql).toContain("AKIAFIXTURE1");
    expect(queries[0]?.sql).toContain("xx-invented-1");
    expect(queries[1]).toEqual({ type: "arrow", sql: "SELECT 1" });
  });

  it("does not reinstall while credentials are unchanged", async () => {
    const { base, queries } = fakeBase();
    stubAwsBroker();
    const connector = brokerConnector(base, { region: "xx-invented-1" });
    await connector.query({ type: "arrow", sql: "SELECT 1" } as never);
    await connector.query({ type: "arrow", sql: "SELECT 2" } as never);
    // One install + two app queries — no second SECRET statement.
    expect(queries.map((q) => q.type)).toEqual(["exec", "arrow", "arrow"]);
  });

  it("reinstalls on rotation (forceRefresh passthrough)", async () => {
    const { base, queries } = fakeBase();
    const { rotate } = stubAwsBroker();
    const connector = brokerConnector(base, {
      region: "xx-invented-1",
      forceRefresh: () => true,
    });
    await connector.query({ type: "arrow", sql: "SELECT 1" } as never);
    rotate("AKIAFIXTURE2");
    await connector.query({ type: "arrow", sql: "SELECT 2" } as never);

    const installs = queries.filter((q) => q.type === "exec");
    expect(installs).toHaveLength(2);
    expect(installs[1]?.sql).toContain("AKIAFIXTURE2");
  });

  it("under the key contract, needs no region: it rides the broker envelope", async () => {
    const { base, queries } = fakeBase();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          accessKeyId: "AKIAFIXTURE1",
          secretAccessKey: "invented-secret",
          sessionToken: "invented-session",
          expiration: new Date(Date.now() + 3_600_000).toISOString(),
          region: "yy-envelope-9",
        }),
        { status: 200 },
      );
    });
    const connector = brokerConnector(base, { key: "app-fixture" });

    await connector.query({ type: "arrow", sql: "SELECT 1" } as never);

    expect(urls).toEqual(["/api/credentials/aws?key=app-fixture"]);
    expect(queries[0]?.sql).toContain("yy-envelope-9");
  });

  it("falls back to SET s3_* and reports the mode through onInstall", async () => {
    const { base, queries } = fakeBase({ rejectCreateSecret: true });
    stubAwsBroker();
    const modes: string[] = [];
    const connector = brokerConnector(base, {
      region: "xx-invented-1",
      onInstall: (mode) => modes.push(mode),
    });
    await connector.query({ type: "arrow", sql: "SELECT 1" } as never);
    expect(modes).toEqual(["SET s3_*"]);
    expect(queries.some((q) => q.sql.includes("SET s3_access_key_id"))).toBe(true);
  });
});
