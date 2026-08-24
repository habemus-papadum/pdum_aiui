/**
 * duckdb.ts — instantiate DuckDB-WASM from *app-bundled* assets, plus the
 * byte-progress fetch that usually accompanies loading a dataset into it.
 * Graduated from the seismos notebook (porcelain-by-extraction).
 *
 * Why the bundles are a **parameter** and not imported here: the asset
 * sourcing is the CONSUMING app's deployment decision, and a library cannot
 * do `?url` imports on the app's behalf anyway — in the published dist build
 * they would inline or dangle (the same class of build-time trap as
 * `import.meta.env`; see the workspace packaging conventions). So the app
 * owns the bundle wiring and this module owns the selection/instantiation
 * dance. Two proven wirings:
 *
 * ```ts
 * // Workers app-bundled (`?url` — same-origin, so a plain `new Worker` works
 * // with no cross-origin Blob bootstrap); wasm from jsDelivr, pinned to the
 * // installed version by getJsDelivrBundles(). The default for the in-repo
 * // apps (demos/wine): the ~35–41 MB binaries blow past static-host
 * // per-file limits (Cloudflare Workers assets cap at 25 MiB), and the CDN
 * // copy is immutable and CORS-open.
 * import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
 * import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
 * const jsd = getJsDelivrBundles();
 * const db = await instantiateDuckDB({
 *   mvp: { mainModule: jsd.mvp.mainModule, mainWorker: mvpWorker },
 *   eh: { mainModule: jsd.eh.mainModule, mainWorker: ehWorker },
 * });
 * ```
 *
 * ```ts
 * // Fully self-hosted: wasm `?url`-imported too, emitted under the app's
 * // own base and origin — for a deploy that must not depend on a CDN and
 * // whose host has no per-file size cap.
 * import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
 * import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
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
 *
 * `workerFactory` is the instrumentation seam: an app that must wrap the
 * worker (scratch's mosaic-taxi patches XHR/fetch inside it to meter DuckDB's
 * S3 traffic honestly; a test can hand back a scripted stand-in) receives the
 * selected bundle's worker URL and returns the Worker to use. Module URLs are
 * passed to `instantiate` ABSOLUTE for the factory's sake: a factory that
 * boots the real worker through a `blob:` bootstrap has no usable base URL,
 * and absolute URLs cost a plain `new Worker` nothing.
 */
export async function instantiateDuckDB(
  bundles: duckdb.DuckDBBundles,
  options: {
    logger?: duckdb.Logger;
    workerFactory?: (workerUrl: string) => Worker;
  } = {},
): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle(bundles);
  if (!bundle.mainWorker) throw new Error("duckdb: no worker in selected bundle");
  const worker = options.workerFactory?.(bundle.mainWorker) ?? new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(options.logger ?? new duckdb.VoidLogger(), worker);
  const absolute = (url: string): string => new URL(url, location.href).href;
  await db.instantiate(
    absolute(bundle.mainModule),
    bundle.pthreadWorker === null || bundle.pthreadWorker === undefined
      ? null
      : absolute(bundle.pthreadWorker),
  );
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
