/**
 * capture.ts — the pen recorder: the imperative island's *source*.
 *
 * This object sees every sample the browser produces, which on an iPad with a
 * Pencil is 120+ per second and, with coalescing, often several per frame. That
 * is precisely why it is a plain class and not a cell: an island that wrote to a
 * signal per sample would spend the whole stroke re-running the reactive graph
 * instead of drawing, and the latency the design is built to protect would be
 * gone before a single dab landed.
 *
 * So the traffic across the reactive boundary is deliberately thin, and it goes
 * one way: the recorder OFFERS a telemetry snapshot whenever it has a new one,
 * and the graph's own `throttled` valve (see store.ts) decides how often that
 * becomes a commit — at most 4 a second, latest wins, last one guaranteed to
 * land. The cadence policy belongs to the boundary, not to the island: this
 * class used to carry a `setInterval` to enforce it, which meant every island
 * that ever published a number re-invented the same timer, slightly differently.
 *
 * Everything else — the in-flight stroke, the sample counters — stays here, in
 * plain fields the draw loop reads directly.
 */

import {
  emptyTelemetry,
  observe,
  type PenSample,
  penSample,
  penSupport,
  type Telemetry,
} from "@habemus-papadum/aiui-pencil";

export type { PenSample as Sample };

export interface RecorderHandlers {
  /**
   * A stroke finished. OPTIONAL, and the Lab does not use it: strokes are
   * recorded by the `PencilSurface` itself, which is the only thing that knows
   * which TOOL drew them. Two independent captures of the same pen is how that
   * fact went missing once already.
   */
  onStrokeEnd?: (samples: PenSample[]) => void;
  /**
   * Offer the latest telemetry. Called freely — the throttle that turns this
   * into ~4 commits a second lives on the signal, not here.
   */
  onTelemetry: (telemetry: Telemetry) => void;
}

export class PenRecorder {
  /** A telemetry snapshot with nothing in it — the store's initial value. */
  static emptySnapshot(): Telemetry {
    return emptyTelemetry();
  }

  /** The in-flight stroke, in canvas-local px. Read directly by the draw loop. */
  live: PenSample[] = [];
  /** Running telemetry. Offered to the graph on every sample; committed at ~4 Hz. */
  telemetry: Telemetry = emptyTelemetry();

  private pointerId: number | undefined;

  /** Wipe the telemetry — "I'm about to tilt the pen, watch what moves". */
  resetTelemetry(): void {
    this.telemetry = emptyTelemetry();
  }

  /**
   * Bind to a canvas. Returns the detach — call it on unmount, and note that it
   * must be safe to call when the canvas has already been adopted by a successor
   * component (an HMR swap), which is why it only ever removes its own listeners.
   */
  attach(canvas: HTMLCanvasElement, handlers: RecorderHandlers): () => void {
    const local = (e: PointerLikeEvent): PenSample => {
      const rect = canvas.getBoundingClientRect();
      const s = penSample(e);
      return { ...s, x: s.x - rect.left, y: s.y - rect.top };
    };

    const record = (e: PointerLikeEvent, samples: PenSample[], predicted: number): void => {
      this.telemetry = observe(this.telemetry, samples, {
        support: penSupport(e),
        coalesced: samples.length,
        predicted,
      });
      handlers.onTelemetry(this.telemetry); // offered, not committed — see store.ts
    };

    const down = (e: PointerEvent): void => {
      if (e.pointerType === "mouse" && e.button !== 0) {
        return;
      }
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointers have no capturable id; recording works anyway.
      }
      this.pointerId = e.pointerId;
      this.live = [local(e)];
      record(e, this.live, 0);
    };

    const move = (e: PointerEvent): void => {
      if (this.pointerId !== e.pointerId) {
        return;
      }
      // Coalesced events recover the high-frequency samples a pen emits between
      // animation frames. On an iPad this is most of the signal — without it we
      // would be measuring the browser's frame rate, not the pen's.
      const batch = coalesced(e).map(local);
      this.live.push(...batch);
      record(e, batch, predictedCount(e));
    };

    const up = (e: PointerEvent): void => {
      if (this.pointerId !== e.pointerId) {
        return;
      }
      this.pointerId = undefined;
      const finished = this.live;
      this.live = [];
      if (finished.length > 0) {
        handlers.onStrokeEnd?.(finished);
      }
    };

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);

    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
    };
  }
}

// ── the two Pointer Events extensions we lean on, defensively typed ──────────
//
// Both are optional in the wild. `getCoalescedEvents` is the one that matters
// most (it is where an Apple Pencil's real sample rate lives); `getPredictedEvents`
// is measured here but not yet USED — spending it on latency hiding is phase 3,
// and it belongs on a scratch layer that can be thrown away each frame.

type PointerLikeEvent = PointerEvent;

interface WithCoalesced {
  getCoalescedEvents?: () => PointerEvent[];
  getPredictedEvents?: () => PointerEvent[];
}

function coalesced(e: PointerEvent): PointerEvent[] {
  const fn = (e as PointerEvent & WithCoalesced).getCoalescedEvents;
  if (typeof fn === "function") {
    const events = fn.call(e);
    if (events.length > 0) {
      return events;
    }
  }
  return [e];
}

function predictedCount(e: PointerEvent): number {
  const fn = (e as PointerEvent & WithCoalesced).getPredictedEvents;
  if (typeof fn === "function") {
    return fn.call(e).length;
  }
  return 0;
}
