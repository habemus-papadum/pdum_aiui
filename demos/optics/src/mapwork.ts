/**
 * mapwork.ts — the worker-side runner and main-side accumulator for field
 * maps, shared by both demos' thin `.worker.ts` seams (the playbook's rule:
 * the worker file owns only the protocol; the math lives here, in layer 1).
 *
 * Protocol (aiui-viz `workerStream` framing, values below are the payloads):
 *   request  — one {@link MapRequest}: a single coherent map, or a stack of
 *              per-wavelength layers accumulated into an RGB intensity map.
 *   partial  — {@link MapReplyChunk}: a block of z-columns (transferables).
 *   done     — the final chunk. progress — fraction of columns computed.
 *
 * The runner yields a macrotask between chunks (setTimeout 0) so a cancel
 * message can actually be delivered mid-computation — supersession would
 * otherwise wait for the whole map.
 */
import type { Rgb } from "./color";
import { type FieldMapChunk, type FieldMapJob, fieldMapColumns } from "./fieldmap";

export type MapRequest =
  | { kind: "coherent"; job: FieldMapJob; tint: Rgb }
  | { kind: "rgb"; layers: { job: FieldMapJob; color: Rgb }[] };

export type MapReplyChunk =
  | { kind: "coherent"; iz0: number; count: number; re: Float32Array; im: Float32Array }
  | {
      kind: "rgb";
      iz0: number;
      count: number;
      /** |E|² for this layer's block — the accumulator applies the color. */
      intensity: Float32Array;
      color: Rgb;
    };

export interface MapWorkerIo {
  isCancelled: () => boolean;
  post: (
    reply:
      | { type: "partial"; value: MapReplyChunk }
      | { type: "done"; value: MapReplyChunk }
      | { type: "progress"; value: number }
      | { type: "error"; message: string },
    transfer?: Transferable[],
  ) => void;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Run one map request, streaming chunks through `io`. */
export async function runMapRequest(req: MapRequest, io: MapWorkerIo): Promise<void> {
  try {
    if (req.kind === "coherent") {
      const total = req.job.nz;
      let sent = 0;
      let prev: FieldMapChunk | undefined;
      for (const chunk of fieldMapColumns(req.job)) {
        if (io.isCancelled()) return;
        if (prev) {
          io.post({ type: "partial", value: { kind: "coherent", ...prev } }, [
            prev.re.buffer,
            prev.im.buffer,
          ]);
          sent += prev.count;
          io.post({ type: "progress", value: sent / total });
          await tick();
        }
        prev = chunk;
      }
      if (prev && !io.isCancelled()) {
        io.post({ type: "done", value: { kind: "coherent", ...prev } }, [
          prev.re.buffer,
          prev.im.buffer,
        ]);
      }
      return;
    }

    const totalCols = req.layers.reduce((acc, l) => acc + l.job.nz, 0);
    let sentCols = 0;
    let prev: { chunk: MapReplyChunk; transfer: Transferable[] } | undefined;
    for (const layer of req.layers) {
      for (const chunk of fieldMapColumns(layer.job)) {
        if (io.isCancelled()) return;
        const intensity = new Float32Array(chunk.count * layer.job.nx);
        for (let i = 0; i < intensity.length; i++) {
          intensity[i] = chunk.re[i] * chunk.re[i] + chunk.im[i] * chunk.im[i];
        }
        const value: MapReplyChunk = {
          kind: "rgb",
          iz0: chunk.iz0,
          count: chunk.count,
          intensity,
          color: layer.color,
        };
        if (prev) {
          io.post({ type: "partial", value: prev.chunk }, prev.transfer);
          sentCols += prev.chunk.count;
          io.post({ type: "progress", value: sentCols / totalCols });
          await tick();
        }
        prev = { chunk: value, transfer: [intensity.buffer] };
      }
    }
    if (prev && !io.isCancelled()) io.post({ type: "done", value: prev.chunk }, prev.transfer);
  } catch (err) {
    io.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

// --- main-side accumulation ---------------------------------------------------

/** What the FieldMap widget renders (see widgets/FieldMap.tsx). */
export interface MapExtent {
  nx: number;
  nz: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
export type FieldMapData =
  | (MapExtent & { kind: "coherent"; re: Float32Array; im: Float32Array; tint: Rgb })
  | (MapExtent & { kind: "rgb"; rgb: Float32Array });

/**
 * Main-side accumulator: allocate the full buffers for a request, fold chunks
 * in as they stream, and hand out a fresh snapshot object per commit (same
 * buffers, new identity — what a streaming cell should yield).
 */
export function createMapAccumulator(req: MapRequest): {
  write: (chunk: MapReplyChunk) => void;
  snapshot: () => FieldMapData;
} {
  const job = req.kind === "coherent" ? req.job : req.layers[0].job;
  const extent: MapExtent = {
    nx: job.nx,
    nz: job.nz,
    x0: job.x0,
    x1: job.x1,
    z0: job.z0,
    z1: job.z1,
  };
  if (req.kind === "coherent") {
    const re = new Float32Array(job.nx * job.nz);
    const im = new Float32Array(job.nx * job.nz);
    return {
      write: (chunk) => {
        if (chunk.kind !== "coherent") return;
        re.set(chunk.re, chunk.iz0 * job.nx);
        im.set(chunk.im, chunk.iz0 * job.nx);
      },
      snapshot: () => ({ kind: "coherent", ...extent, re, im, tint: req.tint }),
    };
  }
  const rgb = new Float32Array(job.nx * job.nz * 3);
  return {
    write: (chunk) => {
      if (chunk.kind !== "rgb") return;
      const base = chunk.iz0 * job.nx;
      for (let i = 0; i < chunk.intensity.length; i++) {
        const v = chunk.intensity[i];
        rgb[(base + i) * 3] += v * chunk.color[0];
        rgb[(base + i) * 3 + 1] += v * chunk.color[1];
        rgb[(base + i) * 3 + 2] += v * chunk.color[2];
      }
    },
    snapshot: () => ({ kind: "rgb", ...extent, rgb }),
  };
}
