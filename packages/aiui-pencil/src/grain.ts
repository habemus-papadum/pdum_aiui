/**
 * grain.ts — the paper's tooth.
 *
 * This is the single detail that decides whether the mark reads as *pencil* or as
 * a grey line, and it hinges on one rule that is easy to get backwards:
 *
 *   **The tooth belongs to the PAPER, not to the stroke.**
 *
 * If the noise is baked into the brush — sampled in stroke-local coordinates —
 * then the texture slides around with every mark, two strokes crossing show two
 * unrelated grains, and the eye knows instantly that it is fake, even if it
 * cannot say why. Anchor the noise to the *canvas* instead and the opposite
 * happens: strokes drawn over each other catch on the same grain, the page
 * acquires a consistent surface, and the whole thing suddenly looks like graphite
 * on paper. Same noise function; entirely different result.
 *
 * The mechanism is a repeating `CanvasPattern` filled with
 * `globalCompositeOperation = "destination-in"` over a stroke's accumulated
 * alpha — so the grain *multiplies* coverage rather than painting over it — with
 * the fill translated by the tile's own canvas-space origin, which is what keeps
 * the lattice pinned to the page rather than to the tile. See `surface.ts`.
 *
 * The noise itself is two octaves of tileable value noise. One octave looks
 * like blur; two look like fibre.
 */

/** A deterministic PRNG — the same paper every time, which matters for tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smoothstep — the interpolant that makes value noise look organic rather than boxy. */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Two octaves of **tileable** value noise, as a `size × size` field in [0, 1].
 * Pure and exported so the texture can be reasoned about (and tested) without a
 * canvas.
 *
 * Tileability is not a nicety: the field is used as a repeating pattern across
 * the whole page, and a seam would be a visible grid of straight lines running
 * through every stroke on the canvas. It comes from wrapping the lattice indices
 * modulo the cell count, so the right edge interpolates back into the left.
 *
 * `cells` is the coarse octave's lattice resolution; the fine octave runs at
 * double it and a third of the amplitude.
 */
export function noiseField(size: number, cells: number, seed = 1): Float32Array {
  const coarse = lattice(cells, seed);
  const fine = lattice(cells * 2, seed ^ 0x9e3779b9);
  const out = new Float32Array(size * size);

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value =
        sample(coarse, cells, (x / size) * cells, (y / size) * cells) * 0.75 +
        sample(fine, cells * 2, (x / size) * cells * 2, (y / size) * cells * 2) * 0.25;
      out[y * size + x] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  // Normalize to the full 0..1 range, so the `grain` knob means the same thing
  // regardless of how the dice fell for this particular seed.
  const span = max - min;
  if (span > 1e-9) {
    for (let i = 0; i < out.length; i++) {
      out[i] = (out[i] - min) / span;
    }
  }
  return out;
}

function lattice(cells: number, seed: number): Float32Array {
  const random = mulberry32(seed);
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) {
    grid[i] = random();
  }
  return grid;
}

/** Bilinear sample of a wrapping lattice — the wrap is what makes it tile. */
function sample(grid: Float32Array, cells: number, fx: number, fy: number): number {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = smooth(fx - x0);
  const ty = smooth(fy - y0);
  const at = (cx: number, cy: number): number =>
    grid[(((cy % cells) + cells) % cells) * cells + (((cx % cells) + cells) % cells)];

  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

/** How many lattice cells across the texture. More = finer fibre at a given scale. */
const CELLS = 16;

/**
 * Build the tooth as a canvas of pure ALPHA — white, with varying transparency,
 * because it is only ever used as a `destination-in` mask and its colour is never
 * seen.
 *
 * `amount` (0..1) is the depth of the tooth: 0 leaves the mask fully opaque, so
 * grain vanishes with no branch anywhere in the surface; 1 lets the deepest
 * valleys take no graphite at all.
 *
 * `scale` is the tooth size in CSS px. The texture is `CELLS × scale` across, so
 * the returned canvas is bigger than `scale` — that is the point, since a
 * pattern whose repeat is one cell wide would visibly stripe.
 */
export function grainTexture(amount: number, scale: number, seed = 1): HTMLCanvasElement {
  const size = Math.max(16, Math.round(CELLS * Math.max(0.5, scale)));
  const field = noiseField(size, CELLS, seed);

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    return canvas;
  }
  const image = ctx.createImageData(size, size);
  const depth = Math.min(1, Math.max(0, amount));
  for (let i = 0; i < field.length; i++) {
    const coverage = 1 - depth * field[i];
    image.data[i * 4] = 255;
    image.data[i * 4 + 1] = 255;
    image.data[i * 4 + 2] = 255;
    image.data[i * 4 + 3] = Math.round(255 * coverage);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * A cache, because building the texture is the expensive part and the parameters
 * change only when a human drags a slider. Keyed on the parameters that shape it.
 */
export class GrainCache {
  private key = "";
  private texture: HTMLCanvasElement | undefined;
  private pattern: CanvasPattern | null = null;

  /** The repeating pattern for these settings, or `null` when grain is off. */
  patternFor(ctx: CanvasRenderingContext2D, amount: number, scale: number): CanvasPattern | null {
    if (amount <= 0) {
      return null; // no grain: the surface skips the whole masking pass
    }
    const key = `${amount.toFixed(3)}:${scale.toFixed(2)}`;
    if (key !== this.key || this.texture === undefined) {
      this.key = key;
      this.texture = grainTexture(amount, scale);
      this.pattern = null;
    }
    if (this.pattern === null) {
      this.pattern = ctx.createPattern(this.texture, "repeat");
    }
    return this.pattern;
  }
}
