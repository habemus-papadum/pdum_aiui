/**
 * Test-only Worker stub. `@duckdb/duckdb-wasm` references `Worker` in module
 * scope, so merely *importing* `./duckdb` (or `./mosaic`, which reaches it
 * through @uwdata/mosaic-plot) throws under node/jsdom. Import this module
 * FIRST in a test file — ESM evaluates imports in document order — and the
 * global exists before duckdb-wasm's module body runs. No test spawns one.
 * Excluded from the build tsconfig (`src/test-support`), so it never ships.
 */
if (typeof globalThis.Worker === "undefined") {
  class StubWorker {
    onmessage: unknown = null;
    postMessage(): void {}
    terminate(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  }
  (globalThis as { Worker?: unknown }).Worker = StubWorker;
}

export {};
