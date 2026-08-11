import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithProgress, instantiateDuckDB } from "./duckdb";

// instantiateDuckDB's collaborators, captured through a module mock: the
// selected bundle is fixed, AsyncDuckDB records the worker it was handed and
// every instantiate() call's arguments.
const captured = vi.hoisted(() => ({
  instantiateArgs: [] as unknown[][],
  workers: [] as unknown[],
}));
vi.mock("@duckdb/duckdb-wasm", () => ({
  selectBundle: async () => ({
    mainWorker: "assets/w.js",
    mainModule: "assets/m.wasm",
    pthreadWorker: null,
  }),
  VoidLogger: class {},
  AsyncDuckDB: class {
    worker: unknown;
    constructor(_logger: unknown, worker: unknown) {
      this.worker = worker;
      captured.workers.push(worker);
    }
    async instantiate(...args: unknown[]): Promise<void> {
      captured.instantiateArgs.push(args);
    }
  },
}));

/** A streamed Response of `chunks` with an optional Content-Length header. */
function streamed(chunks: Uint8Array[], contentLength?: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  const headers =
    contentLength !== undefined ? { "content-length": String(contentLength) } : undefined;
  return new Response(body, { status: 200, ...(headers ? { headers } : {}) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWithProgress", () => {
  it("concatenates streamed chunks and reports monotone fractions ending at 1", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamed(chunks, 5)),
    );
    const fractions: number[] = [];
    const out = await fetchWithProgress("http://x/data.parquet", (f) => fractions.push(f));
    expect([...out]).toEqual([1, 2, 3, 4, 5]);
    expect(fractions.at(-1)).toBe(1);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
    // Mid-stream reports never claim completion (capped below 1 until done).
    expect(fractions.slice(0, -1).every((f) => f < 1)).toBe(true);
  });

  it("still resolves (progress jumps to 1) when the length is unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamed([new Uint8Array([9, 9])])),
    );
    const fractions: number[] = [];
    const out = await fetchWithProgress("http://x/d", (f) => fractions.push(f));
    expect(out.length).toBe(2);
    expect(fractions).toEqual([1]);
  });

  it("throws with the status on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404, statusText: "Not Found" })),
    );
    await expect(fetchWithProgress("http://x/missing", () => {})).rejects.toThrow(/404/);
  });
});

// A minimal bundles value — selection is mocked, so the content is inert.
const BUNDLES = { eh: { mainModule: "x", mainWorker: "y" } } as Parameters<
  typeof instantiateDuckDB
>[0];

describe("instantiateDuckDB", () => {
  afterEach(() => {
    captured.instantiateArgs.length = 0;
    captured.workers.length = 0;
  });

  it("hands the selected bundle's worker URL to workerFactory and adopts its Worker", async () => {
    const worker = { theInstrumentedOne: true };
    const factory = vi.fn(() => worker as unknown as Worker);
    await instantiateDuckDB(BUNDLES, { workerFactory: factory });
    expect(factory).toHaveBeenCalledWith("assets/w.js");
    expect(captured.workers).toEqual([worker]);
  });

  it("defaults to new Worker(url) when no factory is given", async () => {
    class FakeWorker {
      constructor(public url: string) {}
    }
    vi.stubGlobal("Worker", FakeWorker);
    await instantiateDuckDB(BUNDLES);
    expect(captured.workers).toHaveLength(1);
    expect((captured.workers[0] as FakeWorker).url).toBe("assets/w.js");
  });

  it("absolutizes module URLs for instantiate — a blob:-bootstrapped worker has no base", async () => {
    await instantiateDuckDB(BUNDLES, { workerFactory: () => ({}) as Worker });
    const [mainModule, pthreadWorker] = captured.instantiateArgs[0];
    expect(mainModule).toBe(new URL("assets/m.wasm", location.href).href);
    expect(pthreadWorker).toBeNull();
  });
});
