/**
 * fieldmap.ts — the 2-D wave-field picture: E(x, z) over a window of the
 * bench, computed column by column so a worker can stream it (the map sweeps
 * in left-to-right, which is also the direction the light travels — a happy
 * accident we keep).
 *
 * Upstream of the (optional) element the field is the *analytic* sum of the
 * sources — exact, no grids. At the element plane the incident field is
 * sampled on the element's own fine grid, multiplied by t(x), and planned
 * once; every downstream column is then one transfer-function multiply + IFFT
 * (propagate.ts). This one machine draws every picture in both notebooks:
 * slits, gratings, zone plates, recording benches, and playback.
 *
 * The generator does only math — the consuming app's worker owns the protocol
 * seam (workerStream) and the macrotask yields between chunks.
 */
import type { Transmission } from "./elements";
import { applyTransmission, type SourceSpec, sourceAt, sourcesOnGrid } from "./field";
import { type PropagationPlan, planPropagation, propagateTo } from "./propagate";

export interface FieldMapJob {
  lambda: number;
  /** Output grid: nx transverse rows × nz axial columns. */
  nx: number;
  nz: number;
  /** World window, µm (x transverse, z along the axis; light → +z). */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  sources: SourceSpec[];
  /** Optional element: a transmission at plane z (its grid = the fine grid). */
  element?: { z: number; t: Transmission };
}

/** A contiguous block of columns, column-major: value(ix, iz) at [(iz−iz0)·nx + ix]. */
export interface FieldMapChunk {
  iz0: number;
  count: number;
  re: Float32Array;
  im: Float32Array;
}

/** Sample coordinates of the output grid. */
export function mapX(job: FieldMapJob, ix: number): number {
  return job.x0 + ((ix + 0.5) / job.nx) * (job.x1 - job.x0);
}
export function mapZ(job: FieldMapJob, iz: number): number {
  return job.z0 + ((iz + 0.5) / job.nz) * (job.z1 - job.z0);
}

/**
 * Generate the map in column blocks of `chunkCols`. Math only; no timers, no
 * postMessage — the caller owns scheduling and transfer.
 */
export function* fieldMapColumns(
  job: FieldMapJob,
  chunkCols = 24,
): Generator<FieldMapChunk, void, undefined> {
  let plan: PropagationPlan | undefined;
  let fineX0 = 0;
  let fineDx = 1;
  let fineN = 0;
  if (job.element) {
    const t = job.element.t;
    const incident = sourcesOnGrid(job.sources, t.n, t.dx, t.x0, job.element.z, job.lambda);
    applyTransmission(incident, t.re, t.im);
    plan = planPropagation(incident, job.lambda);
    fineX0 = t.x0;
    fineDx = t.dx;
    fineN = t.n;
  }

  for (let iz0 = 0; iz0 < job.nz; iz0 += chunkCols) {
    const count = Math.min(chunkCols, job.nz - iz0);
    const re = new Float32Array(count * job.nx);
    const im = new Float32Array(count * job.nx);
    for (let c = 0; c < count; c++) {
      const iz = iz0 + c;
      const z = mapZ(job, iz);
      const off = c * job.nx;
      if (plan && job.element && z >= job.element.z) {
        const f = propagateTo(plan, z - job.element.z);
        for (let ix = 0; ix < job.nx; ix++) {
          const x = mapX(job, ix);
          const j = Math.round((x - fineX0) / fineDx);
          if (j >= 0 && j < fineN) {
            re[off + ix] = f.re[j];
            im[off + ix] = f.im[j];
          }
        }
      } else {
        for (let ix = 0; ix < job.nx; ix++) {
          const x = mapX(job, ix);
          let sr = 0;
          let si = 0;
          for (const s of job.sources) {
            const e = sourceAt(s, x, z, job.lambda);
            sr += e.re;
            si += e.im;
          }
          re[off + ix] = sr;
          im[off + ix] = si;
        }
      }
    }
    yield { iz0, count, re, im };
  }
}

/** Accumulate a chunk into full map buffers laid out column-major
 *  ([iz·nx + ix] — the layout FieldMap uploads as a texture). */
export function writeChunk(
  target: { re: Float32Array; im: Float32Array },
  chunk: FieldMapChunk,
  nx: number,
): void {
  target.re.set(chunk.re, chunk.iz0 * nx);
  target.im.set(chunk.im, chunk.iz0 * nx);
}
