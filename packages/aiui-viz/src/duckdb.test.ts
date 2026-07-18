import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithProgress } from "./duckdb";

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
