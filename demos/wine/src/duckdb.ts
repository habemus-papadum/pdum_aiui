/**
 * duckdb.ts — this app's DuckDB-WASM bundle wiring, the seismos pattern: the
 * instantiation dance lives in `@habemus-papadum/aiui-viz/duckdb`; what stays
 * here is exactly what a library can't own — the choice of where the assets
 * come from. The WORKER files stay app-bundled (`?url` — same-origin, so no
 * cross-origin Blob bootstrap); the WASM binaries come from jsDelivr, pinned
 * to the installed package version by `getJsDelivrBundles()`: at ~35–41 MB
 * each they blow past static-host per-file limits (Cloudflare Workers assets
 * cap at 25 MiB — the FAI pitch deck hit it bundling this module), and the
 * CDN copy is immutable, CORS-open, and shared across every deployment.
 * Only `mvp` + `eh` (no `coi`): the threaded bundle needs COOP/COEP headers a
 * static host can't set; `selectBundle` picks `eh` on every modern browser.
 */
import { type DuckDBBundles, getJsDelivrBundles } from "@duckdb/duckdb-wasm";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";

export { fetchWithProgress, instantiateDuckDB } from "@habemus-papadum/aiui-viz/duckdb";

const jsd = getJsDelivrBundles();
// The type marks eh optional; the runtime list always carries it.
if (jsd.eh === undefined) throw new Error("duckdb-wasm: jsDelivr bundles missing eh");

/** Local workers + CDN wasm, ready for `instantiateDuckDB(BUNDLES)`. */
export const BUNDLES: DuckDBBundles = {
  mvp: { mainModule: jsd.mvp.mainModule, mainWorker: mvpWorker },
  eh: { mainModule: jsd.eh.mainModule, mainWorker: ehWorker },
};
