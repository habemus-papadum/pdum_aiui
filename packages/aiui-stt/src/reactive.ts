/**
 * reactive.ts — the Solid face of an {@link SttHandle}, following the
 * pencil's `inkSignals` pattern (proposal D5): the handle is imperative +
 * callbacks; this lifts its event stream into signals so cells and
 * components compute over dictation the way they compute over anything
 * else. Cell-ness is deliberately NOT baked in — an app that wants the
 * transcript as a cell lifts these signals itself (and has incidentally
 * made dictation visible to the oracle's tool surface).
 *
 * No throttling: deltas arrive at word rate (Scribe's ~1 s heartbeat, the
 * OpenAI wire's token cadence), orders of magnitude below the pencil's pen
 * frequency — every event can afford to cross into the graph.
 *
 * The display side is `LiveDiffText` (aiui-viz/modal): {@link SttSignals.partial}'s
 * cumulative text is exactly what its `update()` wants — appends extend,
 * revisions flash and settle (proposal D6; this package ships no renderer).
 */

import { createSignal } from "solid-js";
import type { SttHandle } from "./stt";
import type { SttFinal, SttStatus } from "./types";

/** A final with the segment it belongs to (signal consumers sort/key by it). */
export type SttSegmentFinal = SttFinal & { segment: number };

export interface SttSignals {
  status: () => SttStatus;
  /** The open segment's CUMULATIVE partial; undefined when nothing streams.
   * Cleared by that segment's final (which lands in {@link finals}). */
  partial: () => { segment: number; text: string } | undefined;
  /** Append-only, in arrival order (FIFO engines = segment order). */
  finals: () => readonly SttSegmentFinal[];
  /** The last reported error, cleared by the next delta/final. */
  lastError: () => { message: string; segment?: number } | undefined;
  /** Unsubscribe from the handle. The signals keep their last values. */
  dispose: () => void;
}

/** Bind a handle's dictation to Solid signals. */
export function sttSignals(handle: SttHandle): SttSignals {
  const [status, setStatus] = createSignal<SttStatus>(handle.status());
  const [partial, setPartial] = createSignal<{ segment: number; text: string } | undefined>(
    undefined,
  );
  const [finals, setFinals] = createSignal<readonly SttSegmentFinal[]>([]);
  const [lastError, setLastError] = createSignal<{ message: string; segment?: number } | undefined>(
    undefined,
  );

  const dispose = handle.subscribe((event) => {
    switch (event.type) {
      case "status":
        setStatus(event.status);
        return;
      case "delta":
        setPartial({ segment: event.segment, text: event.text });
        setLastError(undefined);
        return;
      case "final":
        setFinals((prev) => [...prev, { segment: event.segment, ...event.result }]);
        // Only the finaled segment's partial is stale — a newer segment may
        // already be streaming (its delta arrived after this final's commit).
        setPartial((prev) => (prev?.segment === event.segment ? undefined : prev));
        setLastError(undefined);
        return;
      case "error":
        setLastError({
          message: event.message,
          ...("segment" in event ? { segment: event.segment } : {}),
        });
        return;
      case "diagnostic":
        return; // observability, not state — consumers subscribe directly
    }
  });

  return { status, partial, finals, lastError, dispose };
}
