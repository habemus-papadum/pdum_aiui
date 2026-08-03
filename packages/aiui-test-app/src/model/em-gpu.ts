/**
 * em-gpu.ts — the WebGPU backend for the E-step, the O(n·k) heart of EM.
 *
 * One compute kernel evaluates, for every point, the per-component
 * log-densities (log-sum-exp'd into responsibilities) and accumulates the
 * CENTRAL sufficient statistics — Σr, Σr·dx, Σr·dy, Σr·dx², Σr·dxdy, Σr·dy²
 * with dx,dy relative to each component's entering mean — plus the total
 * log-likelihood. Central moments are the load-bearing choice: raw second
 * moments at board scale (x² ~ 10⁵) would drown small variances in f32;
 * offsets from the mean (dx ~ 10¹) survive it.
 *
 * Reduction shape: each thread grid-strides the points into private
 * registers, threads combine through workgroup shared memory, and each
 * workgroup writes one row of partial sums; the final (tiny) reduction over
 * workgroup rows happens back in JS, in f64. The M-step is JS too
 * ({@link mStepFromSums}) — k is a handful, n is the big number.
 *
 * The whole class is a null-tolerant island: {@link EmGpu.create} resolves
 * `null` wherever WebGPU is missing or fails, and the worker falls back to
 * the pure-JS path, reporting which backend actually ran.
 */
import { type EStepSums, eStepPrecompute, type Mixture2D } from "./mixture2d";

const WG_SIZE = 64;
const MAX_K = 8;
/** Per-workgroup output row: MAX_K components × 6 sums + logLik. */
const STRIDE = MAX_K * 6 + 1;

export { MAX_K };

const SHADER = /* wgsl */ `
struct Params { n: u32, k: u32, threads: u32, _pad: u32 }

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> pts: array<f32>;
// Per component: mx, my, ixx, ixy, iyy, logNorm.
@group(0) @binding(2) var<storage, read> comps: array<f32>;
@group(0) @binding(3) var<storage, read_write> out: array<f32>;

const WG = ${WG_SIZE}u;
const MAXK = ${MAX_K}u;
const STRIDE = ${STRIDE}u;

var<workgroup> acc: array<f32, ${WG_SIZE * STRIDE}>;

@compute @workgroup_size(${WG_SIZE})
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_index) tid: u32,
  @builtin(workgroup_id) wg: vec3<u32>,
) {
  var local: array<f32, STRIDE>;
  for (var f = 0u; f < STRIDE; f++) { local[f] = 0.0; }

  var logp: array<f32, MAXK>;
  var i = gid.x;
  while (i < params.n) {
    let x = pts[2u * i];
    let y = pts[2u * i + 1u];
    var m = -3.0e38;
    for (var j = 0u; j < params.k; j++) {
      let b = 6u * j;
      let dx = x - comps[b];
      let dy = y - comps[b + 1u];
      let maha = comps[b + 2u] * dx * dx + 2.0 * comps[b + 3u] * dx * dy + comps[b + 4u] * dy * dy;
      logp[j] = comps[b + 5u] - 0.5 * maha;
      m = max(m, logp[j]);
    }
    var sum = 0.0;
    for (var j = 0u; j < params.k; j++) { sum += exp(logp[j] - m); }
    let lse = m + log(sum);
    local[STRIDE - 1u] += lse;
    for (var j = 0u; j < params.k; j++) {
      let b = 6u * j;
      let r = exp(logp[j] - lse);
      let dx = x - comps[b];
      let dy = y - comps[b + 1u];
      let o = 6u * j;
      local[o] += r;
      local[o + 1u] += r * dx;
      local[o + 2u] += r * dy;
      local[o + 3u] += r * dx * dx;
      local[o + 4u] += r * dx * dy;
      local[o + 5u] += r * dy * dy;
    }
    i += params.threads;
  }

  for (var f = 0u; f < STRIDE; f++) { acc[tid * STRIDE + f] = local[f]; }
  workgroupBarrier();
  if (tid == 0u) {
    for (var f = 0u; f < STRIDE; f++) {
      var total = 0.0;
      for (var t = 0u; t < WG; t++) { total += acc[t * STRIDE + f]; }
      out[wg.x * STRIDE + f] = total;
    }
  }
}
`;

export class EmGpu {
  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPUComputePipeline,
    private readonly points: GPUBuffer,
    private readonly comps: GPUBuffer,
    private readonly uniforms: GPUBuffer,
    private readonly out: GPUBuffer,
    private readonly staging: GPUBuffer,
    private readonly n: number,
    private readonly wgCount: number,
  ) {}

  /** `null` when WebGPU is unavailable or initialization fails — the caller
   * falls back to the JS backend. */
  static async create(data: Float64Array): Promise<EmGpu | null> {
    try {
      const gpu = (navigator as { gpu?: GPU }).gpu;
      if (!gpu) {
        return null;
      }
      const adapter = await gpu.requestAdapter();
      if (!adapter) {
        return null;
      }
      const device = await adapter.requestDevice();
      const n = data.length / 2;
      const wgCount = Math.max(1, Math.min(128, Math.ceil(n / WG_SIZE)));

      const points = device.createBuffer({
        size: Math.max(16, data.length * 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(points, 0, new Float32Array(data));

      const comps = device.createBuffer({
        size: MAX_K * 6 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const uniforms = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const outSize = wgCount * STRIDE * 4;
      const out = device.createBuffer({
        size: outSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const staging = device.createBuffer({
        size: outSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });

      const pipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module: device.createShaderModule({ code: SHADER }), entryPoint: "main" },
      });
      return new EmGpu(device, pipeline, points, comps, uniforms, out, staging, n, wgCount);
    } catch {
      return null;
    }
  }

  /** One E-step on the GPU. Throws on device loss — the worker catches and
   * finishes the run on the JS path. */
  async eStep(mix: Mixture2D): Promise<EStepSums> {
    const k = mix.components.length;
    if (k > MAX_K) {
      throw new Error(`EmGpu supports at most ${MAX_K} components, got ${k}`);
    }
    const pre = eStepPrecompute(mix);
    const packed = new Float32Array(MAX_K * 6);
    for (let j = 0; j < k; j++) {
      const g = mix.components[j];
      packed.set([g.mx, g.my, pre[j].ixx, pre[j].ixy, pre[j].iyy, pre[j].logNorm], 6 * j);
    }
    this.device.queue.writeBuffer(this.comps, 0, packed);
    this.device.queue.writeBuffer(
      this.uniforms,
      0,
      new Uint32Array([this.n, k, this.wgCount * WG_SIZE, 0]),
    );

    const bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: { buffer: this.points } },
        { binding: 2, resource: { buffer: this.comps } },
        { binding: 3, resource: { buffer: this.out } },
      ],
    });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(this.wgCount);
    pass.end();
    enc.copyBufferToBuffer(this.out, 0, this.staging, 0, this.staging.size);
    this.device.queue.submit([enc.finish()]);

    await this.staging.mapAsync(GPUMapMode.READ);
    const rows = new Float32Array(this.staging.getMappedRange()).slice();
    this.staging.unmap();

    // The last mile of the reduction, in f64: sum the workgroup rows.
    const sums: EStepSums = {
      nk: new Float64Array(k),
      sdx: new Float64Array(k),
      sdy: new Float64Array(k),
      sdxx: new Float64Array(k),
      sdxy: new Float64Array(k),
      sdyy: new Float64Array(k),
      logLik: 0,
    };
    for (let w = 0; w < this.wgCount; w++) {
      const base = w * STRIDE;
      for (let j = 0; j < k; j++) {
        const o = base + 6 * j;
        sums.nk[j] += rows[o];
        sums.sdx[j] += rows[o + 1];
        sums.sdy[j] += rows[o + 2];
        sums.sdxx[j] += rows[o + 3];
        sums.sdxy[j] += rows[o + 4];
        sums.sdyy[j] += rows[o + 5];
      }
      sums.logLik += rows[base + STRIDE - 1];
    }
    return sums;
  }

  destroy(): void {
    this.device.destroy();
  }
}
