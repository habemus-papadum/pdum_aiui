/**
 * End-to-end pipeline that ties the whole TypeScript demo together.
 *
 * {@link Pipeline} imports from `vec3.ts`, `mesh.ts`, and `signals.ts` — it is
 * the densest hub of cross-module references and the entry point exercised by
 * {@link main} in `index.ts`. It mirrors the Python `pipeline.py` fixture.
 */

import { type Mesh, unitTetrahedron } from "./mesh";
import {
  describeSignal,
  fftMagnitude,
  movingAverage,
  type Summary,
  sineWave,
  summary,
} from "./signals";
import { distance, Vec3 } from "./vec3";

/** Aggregated outputs of a {@link Pipeline} run. */
export interface PipelineResult {
  /** Total surface area of the mesh. */
  readonly meshArea: number;
  /** Centroid of the mesh vertices. */
  readonly meshCentroid: Vec3;
  /** Length of the mesh's longest edge. */
  readonly longestEdge: number;
  /** Descriptive statistics of the smoothed signal. */
  readonly smoothedSummary: Summary;
  /** Index of the dominant frequency bin in the smoothed signal's spectrum. */
  readonly dominantBin: number;
}

/**
 * Run a geometry + signal-processing workflow and collect the results.
 *
 * A single object bundles a {@link Mesh} and DSP parameters; {@link Pipeline.run}
 * walks every other module to produce a {@link PipelineResult}.
 */
export class Pipeline {
  readonly mesh: Mesh;
  readonly freq: number;
  readonly sampleRate: number;
  readonly smoothingWindow: number;

  constructor(mesh: Mesh, freq = 8.0, sampleRate = 256, smoothingWindow = 5) {
    this.mesh = mesh;
    this.freq = freq;
    this.sampleRate = sampleRate;
    this.smoothingWindow = smoothingWindow;
  }

  /** Compute mesh area, centroid, and the longest edge. */
  private geometryStats(): {
    area: number;
    center: Vec3;
    longest: number;
  } {
    const area = this.mesh.area();
    const center = this.mesh.centroid();
    const edges = this.mesh.edgeLengths();
    const longest = edges.length > 0 ? Math.max(...edges) : 0;
    return { area, center, longest };
  }

  /** Execute the full pipeline and return the aggregated result. */
  run(): PipelineResult {
    const { area, center, longest } = this.geometryStats();

    // Signal branch: synthesize -> smooth -> summarize -> spectrum.
    const raw = sineWave(this.freq, 1.0, this.sampleRate, 0.3, 1);
    const smoothed = movingAverage(raw, this.smoothingWindow);
    const smoothedSummary = describeSignal(smoothed);

    const spectrum = fftMagnitude(smoothed);
    const dominantBin = argmax(spectrum);

    return {
      meshArea: area,
      meshCentroid: center,
      longestEdge: longest,
      smoothedSummary,
      dominantBin,
    };
  }
}

/** Index of the largest element in `values` (0 for an empty input). */
function argmax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[best]) {
      best = i;
    }
  }
  return best;
}

/** Construct a ready-to-run pipeline over a translated unit tetrahedron. */
export function defaultPipeline(): Pipeline {
  const base = unitTetrahedron();
  // Shift the mesh so the centroid is non-trivial (uses Vec3.add via translate).
  const mesh = base.translate(new Vec3(1, 2, 3));
  // A tiny sanity computation that also exercises distance() from vec3.ts.
  void distance(mesh.vertices[0], mesh.vertices[1]);
  return new Pipeline(mesh);
}

/** Summary statistics of a mesh's edge-length distribution. */
export function summarizeEdges(mesh: Mesh): Summary {
  return summary(mesh.edgeLengths());
}
