/**
 * fetch-cache.ts — byte-progress fetch backed by the Cache API: the ~64 MB of
 * parquet downloads once, every reload after that loads from disk. Degrades
 * to a plain progress fetch where `caches` is unavailable (insecure context,
 * some private modes). Separate from data.ts so the SQL builders stay pure.
 */
import { fetchWithProgress } from "../duckdb";

const CACHE_NAME = "wine-demo-data-v1";

/** Fetch with byte progress, backed by the Cache API when available. */
export async function fetchDataCached(
  url: string,
  onProgress: (fraction: number) => void,
): Promise<Uint8Array> {
  let cache: Cache | undefined;
  if (typeof caches !== "undefined") {
    try {
      cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit !== undefined) {
        const buf = new Uint8Array(await hit.arrayBuffer());
        onProgress(1);
        return buf;
      }
    } catch {
      cache = undefined; // storage denied — plain fetch below
    }
  }
  const bytes = await fetchWithProgress(url, onProgress);
  try {
    await cache?.put(url, new Response(bytes.slice() as BodyInit));
  } catch {
    // Quota or storage failure: the data is in hand either way.
  }
  return bytes;
}
