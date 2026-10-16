/** Consistent Solid snapshots, with a bounded cadence for growing drafts. */
import { createSignal } from "solid-js";
import type { InkChange, InkDraft, InkSnapshot, InkStroke } from "./document";

export interface InkSource {
  snapshot(): InkSnapshot;
  subscribe(listener: (change: InkChange) => void): () => void;
}
export interface InkSignals {
  snapshot: () => InkSnapshot;
  strokes: () => readonly InkStroke[];
  live: () => readonly InkDraft[];
  dispose(): void;
}
export const DEFAULT_LIVE_HZ = 15;

/** Discrete edits publish together; throttling coalesces observations, never samples. */
export function inkSignals(source: InkSource, options: { liveHz?: number } = {}): InkSignals {
  const [snapshot, publish] = createSignal(source.snapshot());
  const interval = 1000 / Math.max(0.001, options.liveHz ?? DEFAULT_LIVE_HZ);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let disposed = false;
  const cancelTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = false;
  };
  const unsubscribe = source.subscribe((event) => {
    if (disposed) return;
    if (event.kind !== "append") {
      cancelTimer();
      publish(() => event.snapshot);
      return;
    }
    pending = true;
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed && pending) {
        pending = false;
        publish(() => source.snapshot());
      }
    }, interval);
  });
  return {
    snapshot,
    strokes: () => snapshot().strokes,
    live: () => snapshot().live,
    dispose() {
      disposed = true;
      unsubscribe();
      cancelTimer();
    },
  };
}
