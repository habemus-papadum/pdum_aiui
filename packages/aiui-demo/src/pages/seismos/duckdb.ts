/**
 * duckdb.ts — instantiate DuckDB-WASM from *locally bundled* assets, and fetch
 * the parquet with byte-level progress.
 *
 * Why not the one-line jsDelivr path Mosaic's wasmConnector takes by default:
 * this site deploys as static files to S3 under base `/aiui/` and must not
 * depend on a CDN at runtime. So we hand Mosaic a DuckDB instance we built
 * ourselves from the manual bundle — the `.wasm` + worker files imported with
 * Vite's `?url` suffix, which makes Vite emit them as first-class assets served
 * from our own origin (dev: `/`, build/preview: `/aiui/`). See NOTES.md.
 *
 * We ship only the `mvp` and `eh` bundles (no `coi`): the threaded/COI bundle
 * needs SharedArrayBuffer with COOP/COEP cross-origin-isolation headers we can't
 * set on plain S3. `selectBundle` picks `eh` on every modern browser.
 */
import * as duckdb from "@duckdb/duckdb-wasm";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

/**
 * Build an AsyncDuckDB from the local bundle. The worker files are served
 * same-origin, so a plain `new Worker(url)` is enough — no cross-origin Blob
 * shim (which is only why the default connector wraps jsDelivr in a Blob).
 */
export async function instantiateDuckDB(): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle(BUNDLES);
  if (!bundle.mainWorker) throw new Error("duckdb: no worker in selected bundle");
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
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
