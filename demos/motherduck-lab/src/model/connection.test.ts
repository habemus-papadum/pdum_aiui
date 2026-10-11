import { whenReady, whenState } from "@habemus-papadum/aiui-viz/testing";
import { setPastedVendorKey } from "@habemus-papadum/aiui-viz/vendor-keys";
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";

const { engine, runner, handle } = vi.hoisted(() => {
  const handle = {
    generation: 1,
    db: {},
    connection: {},
    connect: async () => ({ query: async () => {} }),
  };
  return {
    handle,
    engine: { ready: vi.fn(), close: vi.fn(async () => {}), rebuild: vi.fn(), generation: 0 },
    runner: {
      query: vi.fn(async () => ({ columns: [], types: [], rows: [] })),
      exec: vi.fn(async () => {}),
    },
  };
});

vi.mock("@habemus-papadum/aiui-cf-creds/motherduck", () => ({
  standardMotherDuckEngine: () => engine,
  motherDuckRunner: () => runner,
}));
vi.mock("@habemus-papadum/aiui-viz/duckdb", () => ({
  duckdbAssetsLocation: () => ({ prefix: "/" }),
  registerSqlTools: () => {},
}));
vi.mock("@habemus-papadum/aiui-viz/mosaic-connector", () => ({
  duckdbConnector: () => ({ query: async () => [] }),
}));

afterEach(() => vi.unstubAllGlobals());

it("waits without a token, connects after a paste, and retries a failed engine", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  });
  const { store } = await import("./store");
  const { graph } = await import("./graph");
  flush();
  expect(store.connectAttempt.get()).toBe(0);
  expect(engine.ready).not.toHaveBeenCalled();
  expect(runner.query).not.toHaveBeenCalled();

  engine.ready.mockRejectedValueOnce(new Error("invalid token")).mockResolvedValue(handle);
  setPastedVendorKey("motherduck", "first-token");
  store.connect();
  await whenState(graph().session, "errored");
  expect(engine.close).toHaveBeenCalledOnce();

  setPastedVendorKey("motherduck", "corrected-token");
  store.connect();
  await whenReady(graph().session);
  expect(engine.ready).toHaveBeenCalledTimes(2);
  expect(store.generation()).toBe(1);
  expect(runner.query).toHaveBeenCalled();
});
