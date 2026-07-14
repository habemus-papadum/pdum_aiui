/**
 * reactive.ts — the Solid face of a `PencilSurface`.
 *
 * The surface is a framework-free imperative island (node-tested, several
 * consumers); this module is the boundary where its drawing becomes *signals*,
 * so sibling components and cells can compute over the ink — count points,
 * measure the area of the shape being drawn, drive a readout — the way they
 * compute over anything else.
 *
 * Two signals, two cadences, per the boundary rule:
 *
 *  - **`strokes`** — the committed drawing. Updates *immediately* on commit,
 *    undo, clear, and fade-out: these are discrete human-rate events, and a
 *    consumer watching stroke count must never see it lag a visible change.
 *  - **`live`** — the strokes in flight. The pen feeds this at 60–120 Hz, so it
 *    goes through `throttled()` (~15 Hz default). **Nothing is lost to the
 *    throttle**, by construction rather than by care: every emission is a
 *    cumulative snapshot — all points captured so far — so coalescing drops
 *    *emissions*, never *data*. A stats cell computing over the latest snapshot
 *    always has every point.
 *
 * The one subtlety is the handoff between them: a commit removes a stroke from
 * the live set and adds it to the committed list *in the same instant*, but the
 * live signal is throttled — left alone, the stroke would appear in BOTH
 * signals for up to a throttle window, and a consumer summing the two would
 * double-count it. So discrete events flush the live box synchronously: the two
 * signals move together whenever the committed list changes.
 */

import { throttled } from "@habemus-papadum/aiui-viz";
import { createSignal } from "solid-js";
import type { InkEvent, InkState, InkStroke } from "./surface";

/**
 * What the adapter actually needs from a surface — structural, so tests can
 * drive it with a fake and never touch a canvas.
 */
export interface InkSource {
  ink(): InkState;
  subscribe(listener: (event: InkEvent) => void): () => void;
}

/** How often the live stroke's snapshot crosses into the graph, by default. */
export const DEFAULT_LIVE_HZ = 15;

export interface InkSignals {
  /** The committed drawing. Immediate — never throttled. */
  strokes: () => readonly InkStroke[];
  /** The strokes in flight, cumulative points. Throttled; lossless snapshots. */
  live: () => readonly InkStroke[];
  /** Unsubscribe from the surface. The signals keep their last values. */
  dispose: () => void;
}

/**
 * Bind a surface's drawing to Solid signals.
 *
 * ```ts
 * // store.ts — the surface is durable, so the binding hangs off it
 * export const ink = durable("ink", () => inkSignals(paper));
 *
 * // graph.ts — the drawing is now just another dependency
 * stats: cell(
 *   () => ({ strokes: ink.strokes(), live: ink.live() }),
 *   ({ strokes, live }) => summarize(strokes, live),
 * )
 * ```
 */
export function inkSignals(source: InkSource, opts: { liveHz?: number } = {}): InkSignals {
  const initial = source.ink();
  const [strokes, setStrokes] = createSignal(initial.strokes);
  const [liveGet, liveSet] = createSignal(initial.live);
  const live = throttled({ get: liveGet, set: liveSet }, opts.liveHz ?? DEFAULT_LIVE_HZ);

  const unsubscribe = source.subscribe((event) => {
    const state = source.ink();
    if (event === "strokes") {
      setStrokes(() => state.strokes);
      // The handoff: the committed list just changed, so the live set changed
      // with it (a commit moves a stroke across). Flush the throttle so no
      // stroke is ever visible in both signals at once.
      live.set(() => state.live);
      live.flush();
    } else {
      live.set(() => state.live);
    }
  });

  return { strokes, live: live.get, dispose: unsubscribe };
}
