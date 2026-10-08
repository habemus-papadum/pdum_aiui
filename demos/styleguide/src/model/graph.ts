/**
 * graph.ts — the styleguide's cell graph: two cells that exist to exhibit the
 * cell STATES (pending with progress, loading with the last value dimmed,
 * errored with Retry) through the real CellView, plus the standard agent
 * tools every aiui app registers. Rebuilt over the durable roots on every hot
 * edit (hotCellGraph).
 */
import { agentToolkit, cell, hotCellGraph, registerStandardTools } from "@habemus-papadum/aiui-viz";
import { appScope, breakCatalog, feed, kill } from "./store";

/** A cancellable pause — the cell's abort signal ends it early. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export const graph = hotCellGraph(
  appScope.name,
  () => ({
    /** The pattern wavelength the plate would show at (feed, kill), in cells —
     * a deliberately slow derivation, so the loading stripe is visible. */
    wavelength: cell(
      () => ({ f: feed.get(), k: kill.get() }),
      async ({ f, k }, ctx): Promise<number> => {
        for (let i = 1; i <= 4; i++) {
          await wait(160, ctx.signal);
          ctx.progress(i / 4);
        }
        // A toy dispersion: wider patterns as kill approaches feed's half-point.
        const gap = Math.max(1e-3, k - f / 2 + 0.006);
        return 6 + 0.5 / gap;
      },
      { scope: appScope },
    ),
    /** The catalog headline — breaks on demand (the `breakCatalog` control) to
     * exhibit the error surface and its Retry. */
    catalog: cell(
      () => ({ fail: breakCatalog.get() }),
      async ({ fail }, ctx): Promise<{ events: number; largest: number; sinceYear: number }> => {
        await wait(400, ctx.signal);
        if (fail) {
          throw new Error("TypeError: failed to fetch — /data/catalog.parquet");
        }
        return { events: 269952, largest: 9.1, sinceYear: 1976 };
      },
      { scope: appScope },
    ),
  }),
  import.meta.hot,
);

export type AppGraph = ReturnType<typeof graph>;

const kit = agentToolkit(appScope.name);
registerStandardTools(kit);
