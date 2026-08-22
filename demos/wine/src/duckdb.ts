/**
 * duckdb.ts — this app's DuckDB-WASM bundle wiring, the seismos pattern: the
 * instantiation dance lives in `@habemus-papadum/aiui-viz/duckdb`; what stays
 * here is exactly what a library can't own — the `?url` asset imports, which
 * make Vite emit the wasm/worker files as first-class assets of THIS app.
 * Only `mvp` + `eh` (no `coi`): the threaded bundle needs COOP/COEP headers a
 * static host can't set; `selectBundle` picks `eh` on every modern browser.
 */
import type { DuckDBBundles } from "@duckdb/duckdb-wasm";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";

export { fetchWithProgress, instantiateDuckDB } from "@habemus-papadum/aiui-viz/duckdb";

/** The locally bundled DuckDB assets, ready for `instantiateDuckDB(BUNDLES)`. */
export const BUNDLES: DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};
