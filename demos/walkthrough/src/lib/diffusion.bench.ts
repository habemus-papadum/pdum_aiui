/**
 * diffusion.bench.ts — the numbers behind the layer-2 decision. The playbook
 * says: measure before choosing where a computation runs. Run with
 * `pnpm exec vitest bench` (benches never run in CI's `vitest run`).
 *
 * Ballpark from this machine's runs: one FTCS step at n = 1024 is ~1 µs, so a
 * full evolution (κ = 1, T = 0.05 → ~10⁵ steps) is ~0.1–1 s — long enough to
 * freeze a frame or two on the main thread, short enough that a worker with
 * streaming partials makes it feel instant. Hence: worker, chunked, streamed.
 */
import { bench, describe } from "vitest";
import { diffusionStep, initialProfile } from "./diffusion";

for (const n of [128, 512, 1024]) {
  describe(`FTCS step, n = ${n}`, () => {
    const u = initialProfile("gaussian", n);
    const out = new Float64Array(n);
    bench("diffusionStep", () => {
      diffusionStep(u, 0.45, out);
    });
  });
}
