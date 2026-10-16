/** Run from the repo root: pnpm exec tsx packages/aiui-pencil/lab/benchmark-geometry.ts */
import { performance } from "node:perf_hooks";
import { earliestChangedDab, planBrush, planStroke } from "../src/dabs";
import { WRITE } from "../src/pencil";
import { processStrokeGeometry } from "../src/stroke-geometry";
import type { PenSample } from "../src/telemetry";

/** Synthetic 120Hz looping handwriting, with turns, irregular motion, and telemetry variation. */
function samples(count: number): PenSample[] {
  return Array.from({ length: count }, (_, i) => {
    const phase = (i % 97 === 0 ? Math.max(0, i - 1) : i) / 18;
    return {
      x: 40 + i * 0.8 + 25 * Math.sin(phase),
      y: 80 + 25 * Math.sin(2 * phase),
      t: i * (1000 / 120),
      pressure: 0.6 + 0.3 * Math.sin(i / 27),
      altitude: Math.PI / 3 + 0.2 * Math.sin(i / 13),
      azimuth: i / 30,
      twist: 0,
      kind: "pen",
      width: 2,
      height: 2,
    };
  });
}

function time(operation: () => unknown, iterations: number): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) operation();
  return (performance.now() - start) / iterations;
}

// Warm code paths before measuring. This measures CPU planning, not browser paint or input latency.
for (let i = 0; i < 30; i++) planStroke(samples(240), WRITE);

for (const count of [600, 2400]) {
  const raw = samples(count);
  const geometry = processStrokeGeometry(raw, WRITE);
  let previous = planStroke([], WRITE).dabs;
  const durations: number[] = [];
  let totalChangedDabs = 0;
  let prefixTotal = 0;
  // Four coalesced samples per publication; every prefix is recomputed from source.
  for (let end = 4; end <= count; end += 4) {
    const start = performance.now();
    const next = planStroke(raw.slice(0, end), WRITE).dabs;
    totalChangedDabs += next.length - earliestChangedDab(previous, next);
    const duration = performance.now() - start;
    prefixTotal += duration;
    durations.push(duration);
    previous = next;
  }
  durations.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      source: "synthetic 120Hz looping handwriting; CPU only",
      node: process.version,
      samples: count,
      durationSeconds: count / 120,
      dabs: previous.length,
      geometryMs: +time(() => processStrokeGeometry(raw, WRITE), 30).toFixed(3),
      brushMs: +time(() => planBrush(geometry, WRITE), 30).toFixed(3),
      fullBatchMs: +time(() => planStroke(raw, WRITE), 30).toFixed(3),
      prefixTotalMs: +prefixTotal.toFixed(3),
      prefixP95Ms: +durations[Math.floor(durations.length * 0.95)].toFixed(3),
      prefixMaxMs: +durations[durations.length - 1].toFixed(3),
      changedDabsAcrossPrefixes: totalChangedDabs,
    }),
  );
}
