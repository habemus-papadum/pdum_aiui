/**
 * Public API barrel + demo entry point for the TypeScript half of `py-demo`.
 *
 * This file re-exports every module's public surface (so consumers can
 * `import { Vec3, Mesh, Pipeline } from "./index"`) and provides a {@link main}
 * that constructs a {@link Pipeline} and prints a result. It does not need to
 * actually run — it only needs to typecheck cleanly and hold real references
 * for the code reader's go-to-definition / find-references demos.
 */

export type { BoundingBox, Face } from "./mesh";
export { Mesh, unitTetrahedron } from "./mesh";
export type { PipelineResult } from "./pipeline";
export { defaultPipeline, Pipeline, summarizeEdges } from "./pipeline";
export type { ArrayLike, Summary } from "./signals";
export {
  describeSignal,
  fftMagnitude,
  movingAverage,
  sineWave,
  summary,
} from "./signals";
export type { Vec3Tuple } from "./vec3";
export { centroid, distance, Vec3 } from "./vec3";

import type { PipelineResult } from "./pipeline";
import { defaultPipeline } from "./pipeline";

/**
 * Build the default pipeline, run it, and log a human-readable summary.
 *
 * Conceptually runnable via a bundler (`node`, Vite, esbuild, …); wiring it to
 * an actual runtime is out of scope for this typecheck-only fixture.
 */
export function main(): PipelineResult {
  const pipeline = defaultPipeline();
  const result = pipeline.run();

  const { x, y, z } = result.meshCentroid;
  console.log("mesh area:      ", result.meshArea.toFixed(4));
  console.log("mesh centroid:  ", `(${x}, ${y}, ${z})`);
  console.log("longest edge:   ", result.longestEdge.toFixed(4));
  console.log("dominant bin:   ", result.dominantBin);
  console.log(
    "signal mean/std:",
    result.smoothedSummary.mean.toFixed(4),
    "/",
    result.smoothedSummary.std.toFixed(4),
  );

  return result;
}

// A bundler entry point would call `main()` here; kept as an exported function
// (rather than a side-effecting top-level call) so importing the barrel for its
// types never triggers the console output. No Node globals are referenced, so
// the module type-checks with only the `ES2022` + `DOM` libs — zero deps.
