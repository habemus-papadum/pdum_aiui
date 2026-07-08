/**
 * duckdb.ts — instantiate DuckDB-WASM from *app-bundled* assets, plus the
 * byte-progress fetch that usually accompanies loading a dataset into it.
 * Graduated from the seismos notebook (porcelain-by-extraction).
 *
 * Why the bundles are a **parameter** and not imported here: the assets must
 * be first-class files of the CONSUMING app — imported with Vite's `?url`
 * suffix so they're emitted under the app's own base and origin (no jsDelivr
 * at runtime; a static-S3 deploy can't depend on a CDN). A library cannot do
 * `?url` imports on the app's behalf: in the published dist build they would
 * inline or dangle (the same class of build-time trap as `import.meta.env` —
 * see the workspace packaging conventions). So the app owns four one-line
 * imports and this module owns the selection/instantiation dance:
 *
 * ```ts
 * import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
 * import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
 * import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
 * import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
 * const db = await instantiateDuckDB({
 *   mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
 *   eh: { mainModule: ehWasm, mainWorker: ehWorker },
 * });
 * ```
 *
 * Ship only `mvp` + `eh` (no `coi`): the threaded/COI bundle needs
 * SharedArrayBuffer with COOP/COEP cross-origin-isolation headers a static
 * host can't set. `selectBundle` picks `eh` on every modern browser. Pin
 * `@duckdb/duckdb-wasm` to the exact version `@uwdata/mosaic-core` depends on
 * so one deduped copy exists (frontend-hard-won §Mosaic).
 *
 * Lives on its own subpath (`@habemus-papadum/aiui-viz/duckdb`) so
 * `@duckdb/duckdb-wasm` stays an optional peer only DuckDB consumers install.
 */
import * as duckdb from "@duckdb/duckdb-wasm";

/**
 * Build an AsyncDuckDB from the app's bundles. The worker files are served
 * same-origin, so a plain `new Worker(url)` is enough — no cross-origin Blob
 * shim (which is only why duckdb-wasm's jsDelivr path wraps a Blob).
 */
export async function instantiateDuckDB(
  bundles: duckdb.DuckDBBundles,
  options: { logger?: duckdb.Logger } = {},
): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle(bundles);
  if (!bundle.mainWorker) throw new Error("duckdb: no worker in selected bundle");
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(options.logger ?? new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  return db;
}

/**
 * Fetch `url` into memory, reporting fraction-complete from the Content-Length
 * and the streamed byte count. Falls back to a single arrayBuffer read when the
 * body isn't a readable stream (or the length is unknown).
 */
export async function fetchWithProgress(
  url: string,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`fetch ${url} — ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(1);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) onProgress(Math.min(0.999, received / total));
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  onProgress(1);
  return out;
}
