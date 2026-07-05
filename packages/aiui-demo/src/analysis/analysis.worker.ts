/**
 * analysis.worker.ts — heavy pattern-structure analysis, off the main thread.
 *
 * Speaks the cancellable request/stream protocol of @habemus-papadum/aiui-viz
 * (worker-stream):
 * streams a partial result as soon as the cheap phase (spot census) is done,
 * reports progress through the expensive phase (autocorrelation), yields to
 * the event loop between chunks so "cancel" messages can actually be
 * delivered (message events are macrotasks — a microtask is not enough), and
 * posts "done" with the full result.
 *
 * The math lives in ./core (pure, unit-tested); this file is only the
 * choreography. `quality` scales the autocorrelation lag range — the knob
 * that makes runs take visibly long, so cancellation and progress are real.
 */
import type { WorkerReply, WorkerRequest } from "@habemus-papadum/aiui-viz";
import {
  areaHistogram,
  autocorrelationAtLag,
  dominantWavelength,
  labelComponents,
  type SpotCensus,
} from "./core";

export interface AnalysisParams {
  field: Float32Array; // V channel, row-major
  width: number;
  height: number;
  threshold: number;
  /** 1 (fast) .. 5 (thorough): scales the autocorrelation lag range. */
  quality: number;
}

export interface AnalysisResult {
  census: Pick<SpotCensus, "count" | "meanArea" | "largestFraction">;
  histogram: { area: number; count: number }[];
  /** Dominant pattern wavelength in pixels, if one stands out. */
  wavelength: number | undefined;
  correlogram: { lag: number; correlation: number }[];
  /** Wall-clock cost of the run, for the HUD. */
  elapsedMs: number;
  phase: "census" | "complete";
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};

const cancelled = new Set<number>();
const post = (message: WorkerReply<AnalysisResult>) => scope.postMessage(message);

scope.onmessage = async (event: MessageEvent) => {
  const msg = event.data as WorkerRequest<AnalysisParams>;
  if (msg.type === "cancel") {
    cancelled.add(msg.id);
    return;
  }
  if (msg.type !== "run") return;
  const { id, payload } = msg;
  const { field, width, height, threshold, quality } = payload;
  const started = performance.now();

  const yieldToEvents = () => new Promise((resolve) => setTimeout(resolve, 0));
  const isCancelled = () => {
    if (cancelled.has(id)) {
      cancelled.delete(id);
      return true;
    }
    return false;
  };

  try {
    // Phase 1 — spot census (cheap): stream it immediately as a partial.
    const census = labelComponents(field, width, height, threshold);
    const partial: AnalysisResult = {
      census: {
        count: census.count,
        meanArea: census.meanArea,
        largestFraction: census.largestFraction,
      },
      histogram: areaHistogram(census.areas),
      wavelength: undefined,
      correlogram: [],
      elapsedMs: performance.now() - started,
      phase: "census",
    };
    post({ id, type: "progress", value: 0.1 });
    post({ id, type: "partial", value: partial });

    // Phase 2 — autocorrelation sweep (expensive, chunked per lag).
    const maxLag = Math.min(Math.floor(width / 2), 24 + quality * 20);
    // Extra passes make high quality *feel* like a long computation — this is
    // a demo of progress/cancel choreography as much as of the math.
    const passes = quality;
    let mean = 0;
    for (let i = 0; i < field.length; i++) mean += field[i];
    mean /= field.length;

    const correlogram: number[] = [];
    const totalChunks = maxLag * passes;
    let chunk = 0;
    for (let lag = 1; lag <= maxLag; lag++) {
      let c = 0;
      for (let p = 0; p < passes; p++) {
        c = autocorrelationAtLag(field, width, height, mean, lag);
        chunk++;
        if (chunk % 4 === 0) {
          await yieldToEvents();
          if (isCancelled()) return;
          post({ id, type: "progress", value: 0.1 + 0.9 * (chunk / totalChunks) });
        }
      }
      correlogram.push(c);
    }

    const result: AnalysisResult = {
      ...partial,
      wavelength: dominantWavelength(correlogram),
      correlogram: correlogram.map((correlation, i) => ({ lag: i + 1, correlation })),
      elapsedMs: performance.now() - started,
      phase: "complete",
    };
    post({ id, type: "done", value: result });
  } catch (err) {
    post({ id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
