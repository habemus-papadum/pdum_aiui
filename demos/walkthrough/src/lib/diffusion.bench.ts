/**
 * diffusion.bench.ts — the numbers behind the layer-2 decision. The playbook
 * says: measure before choosing where a computation runs. Run with
 * `pnpm exec vitest bench` (a `.bench.ts` file is outside the test glob, so CI's
 * `vitest run` never runs it).
 *
 * Ballpark from this machine's runs: one FTCS step at n = 1024 is ~1 µs, so a
 * full evolution (κ = 1, T = 0.05 → ~10⁵ steps) is ~0.1–1 s — long enough to
 * freeze a frame or two on the main thread, short enough that a worker with
 * streaming partials makes it feel instant. Hence: worker, chunked, streamed.
 */
import { test } from "vitest";
import { diffusionStep, initialProfile } from "./diffusion";

// Vitest 5's benchmark API: a bench is PART of a test — the `bench` fixture
// registers a case and `.run()` measures it through tinybench (several cases
// go through `bench.compare(...)` instead).
for (const n of [128, 512, 1024]) {
  test(`FTCS step, n = ${n}`, async ({ bench }) => {
    const u = initialProfile("gaussian", n);
    const out = new Float64Array(n);
    await bench("diffusionStep", () => {
      diffusionStep(u, 0.45, out);
    }).run();
  });
}
