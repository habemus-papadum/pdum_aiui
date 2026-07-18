/**
 * Test-only Worker stub. `@duckdb/duckdb-wasm` references `Worker` in module
 * scope, so merely *importing* `./duckdb` (or `./mosaic`, which reaches it
 * through @uwdata/mosaic-plot) throws under node/jsdom. Wired as a Vitest
 * `setupFiles` entry (vite.config.ts), which runs before any test module —
 * no import-order discipline required. No test spawns one. Excluded from the
 * build tsconfig (`src/test-support`), so it never ships.
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
