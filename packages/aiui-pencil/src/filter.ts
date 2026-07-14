/**
 * filter.ts — the One-Euro causal low-pass. Playbook layer 1: pure, realm-free.
 *
 * The problem it solves is the one every hand-drawn line has: a pen held still
 * jitters, and a pen moving fast must not be lagged. Those two demands pull in
 * opposite directions for any fixed-cutoff filter — smooth enough to kill the
 * tremor is sluggish enough to feel like drawing through syrup.
 *
 * One-Euro (Casiez, Roussel & Vogel, CHI 2012) resolves it by making the cutoff
 * a function of *speed*: filter hard when the pen is slow (where jitter lives and
 * lag is invisible), barely at all when it is fast (where lag is everything and
 * jitter is masked by motion). Two parameters do the work — `minCutoff` sets the
 * floor (how still a still pen is) and `beta` sets how fast the filter gets out
 * of the way (how responsive a moving pen is).
 *
 * It is **causal**, which is the entire reason it is here rather than a spline
 * fit or a moving average over a window. A filter that looks ahead buys its
 * smoothness with latency, and latency is precisely what this design is
 * protecting — a stroke that appears 40ms after the pen does not feel like ink,
 * no matter how smooth it is.
 */

/** One-Euro's three knobs. Tuned per pencil preset; see `pencil.ts`. */
export interface OneEuroConfig {
  /**
   * Cutoff frequency (Hz) at zero speed — the floor. Lower = a stiller still
   * pen, and more lag when it starts moving. This is the jitter knob.
   */
  minCutoff: number;
  /**
   * Speed coefficient. Higher = the filter opens up sooner as the pen
   * accelerates, trading smoothness back for responsiveness. This is the lag
   * knob, and it is the one that separates writing from sketching.
   */
  beta: number;
  /** Cutoff (Hz) for the *speed estimate* itself. Rarely worth moving; 1.0 is standard. */
  dCutoff: number;
}

/**
 * The exponential smoothing factor for a cutoff and a timestep — the standard
 * one-pole low-pass in the form One-Euro uses. `dt <= 0` returns 1 (no
 * smoothing), which is the only sane answer when two samples share a timestamp.
 */
export function smoothingAlpha(cutoffHz: number, dtMs: number): number {
  if (dtMs <= 0 || cutoffHz <= 0) {
    return 1;
  }
  const tau = 1 / (2 * Math.PI * cutoffHz);
  const dt = dtMs / 1000;
  return 1 / (1 + tau / dt);
}

/** A one-pole low-pass with its own memory. */
class LowPass {
  private value: number | undefined;

  filter(x: number, alpha: number): number {
    const next = this.value === undefined ? x : alpha * x + (1 - alpha) * this.value;
    this.value = next;
    return next;
  }

  get last(): number | undefined {
    return this.value;
  }

  reset(): void {
    this.value = undefined;
  }
}

/**
 * A One-Euro filter over one scalar. Stateful (it is a filter), but wholly
 * deterministic in its inputs — feed it the same sequence and it produces the
 * same sequence, which is what makes it testable without a pen.
 */
export class OneEuro {
  private readonly x = new LowPass();
  private readonly dx = new LowPass();
  private lastT: number | undefined;

  constructor(private config: OneEuroConfig) {}

  /** Retune mid-stroke (a control moved). The filter's memory is deliberately kept. */
  setConfig(config: OneEuroConfig): void {
    this.config = config;
  }

  /** Forget everything — the start of a new stroke. */
  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastT = undefined;
  }

  filter(value: number, tMs: number): number {
    const dt = this.lastT === undefined ? 0 : tMs - this.lastT;
    this.lastT = tMs;

    // Speed, itself low-passed — a raw derivative of a noisy signal is noise.
    const previous = this.x.last;
    const rate = previous === undefined || dt <= 0 ? 0 : ((value - previous) / dt) * 1000;
    const rateHat = this.dx.filter(rate, smoothingAlpha(this.config.dCutoff, dt));

    // The whole idea, in one line: the faster it moves, the less we filter.
    const cutoff = this.config.minCutoff + this.config.beta * Math.abs(rateHat);
    return this.x.filter(value, smoothingAlpha(cutoff, dt));
  }
}

/**
 * A One-Euro filter over a 2-D point — two independent scalar filters sharing a
 * clock. Independent per axis is the standard formulation and it is right: the
 * jitter that matters is not radial.
 */
export class PointFilter {
  private readonly fx: OneEuro;
  private readonly fy: OneEuro;

  constructor(config: OneEuroConfig) {
    this.fx = new OneEuro(config);
    this.fy = new OneEuro(config);
  }

  setConfig(config: OneEuroConfig): void {
    this.fx.setConfig(config);
    this.fy.setConfig(config);
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }

  filter(x: number, y: number, tMs: number): { x: number; y: number } {
    return { x: this.fx.filter(x, tMs), y: this.fy.filter(y, tMs) };
  }
}
