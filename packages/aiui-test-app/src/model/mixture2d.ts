/**
 * mixture2d.ts — the mathematics of a 2-D Gaussian mixture. Playbook layer 1:
 * pure, realm-free (no DOM, no solid-js, no async), exhaustively tested.
 *
 * The app's domain objects and every closed-form operation over them:
 *
 *  - {@link fitStrokeEllipse} — a drawn stroke → the best moment ellipse. For
 *    points spread over an ellipse outline the second central moments are
 *    exactly (a²/2, b²/2) along the axes, so axes fall straight out of the
 *    2×2 eigenproblem. This is how a hand-drawn loop becomes a component.
 *  - {@link gaussianFromEllipse} / {@link ellipseFromGaussian} — the drawn
 *    outline is read as the {@link CONTOUR_SIGMA}σ Mahalanobis contour of the
 *    component, and fitted components are displayed at the same contour, so
 *    truth and estimate are visually commensurable.
 *  - {@link samplePoint} — draw from the mixture (Box–Muller through each
 *    component's Cholesky factor).
 *  - {@link hexbin} — the 2-D histogram: pointy-top hexagonal binning.
 *  - {@link emStep2d} — one EM iteration over interleaved-xy data, with the
 *    log-likelihood of the *entering* parameters computed via log-sum-exp
 *    (the number whose monotone climb the chart watches).
 *
 * Coordinates are "board units" throughout — the fixed viewBox space the
 * drawing surface and every overlay share. Nothing here knows about pixels.
 */

// ── types ────────────────────────────────────────────────────────────────────

export interface Vec2 {
  x: number;
  y: number;
}

/** One mixture component: mean and (symmetric) covariance, board units. */
export interface Gaussian2D {
  mx: number;
  my: number;
  sxx: number;
  sxy: number;
  syy: number;
}

/** The full mixture. `weights` sums to 1 and matches `components` in length. */
export interface Mixture2D {
  weights: number[];
  components: Gaussian2D[];
}

/** Display geometry of an ellipse: centre, semi-axes (a ≥ b), tilt radians. */
export interface EllipseShape {
  cx: number;
  cy: number;
  a: number;
  b: number;
  angle: number;
}

/** One EM iteration's result. `logLik` belongs to the entering parameters. */
export interface FitStep2D {
  iter: number;
  params: Mixture2D;
  logLik: number;
}

/** A drawn ellipse is read as this Mahalanobis contour of its component (2σ
 * encloses ~86% of a 2-D Gaussian's mass — about what a hand sketching "the
 * blob" means). Fitted components render at the same contour. */
export const CONTOUR_SIGMA = 2;

/** Variance floor, board units² — no component may collapse onto a point. */
export const MIN_VAR = 4;

// ── randomness (seedable, deterministic) ─────────────────────────────────────

/** A small, fast, seedable PRNG (mulberry32) — what makes "reseed" meaningful
 * and every screenshot reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One standard normal deviate (Box–Muller; cosine branch). */
export function standardNormal(rand: () => number): number {
  const u = 1 - rand(); // rand() can be exactly 0, and log(0) is -Infinity
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── 2×2 symmetric linear algebra ─────────────────────────────────────────────

/** Eigen-decomposition of [[sxx, sxy], [sxy, syy]]: eigenvalues l1 ≥ l2 and
 * the angle of the l1 eigenvector, closed form. */
export function eigen2x2(
  sxx: number,
  sxy: number,
  syy: number,
): { l1: number; l2: number; angle: number } {
  const half = (sxx - syy) / 2;
  const spread = Math.sqrt(half * half + sxy * sxy);
  const mid = (sxx + syy) / 2;
  return { l1: mid + spread, l2: mid - spread, angle: Math.atan2(2 * sxy, sxx - syy) / 2 };
}

/** Lower Cholesky factor of a component's covariance: [[l11, 0], [l21, l22]].
 * Assumes the covariance is positive definite (every constructor here floors
 * variances at {@link MIN_VAR}). */
export function cholesky2x2(g: Gaussian2D): { l11: number; l21: number; l22: number } {
  const l11 = Math.sqrt(g.sxx);
  const l21 = g.sxy / l11;
  const l22 = Math.sqrt(Math.max(g.syy - l21 * l21, 1e-12));
  return { l11, l21, l22 };
}

// ── strokes → components ─────────────────────────────────────────────────────

/**
 * Fit an ellipse to a drawn outline by its second central moments. For points
 * spread over an ellipse boundary (x = a·cos t, y = b·sin t, t uniform) the
 * central moments are exactly a²/2 and b²/2 along the axes, so the semi-axes
 * are √(2λ) of the moment eigenvalues. `null` when the stroke is too short or
 * has no spread — the caller ignores the stroke rather than minting a
 * degenerate component.
 */
export function fitStrokeEllipse(points: readonly Vec2[]): EllipseShape | null {
  if (points.length < 8) {
    return null;
  }
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  sxx /= points.length;
  sxy /= points.length;
  syy /= points.length;

  const { l1, l2, angle } = eigen2x2(sxx, sxy, syy);
  if (l1 <= 0) {
    return null;
  }
  return { cx, cy, a: Math.sqrt(2 * l1), b: Math.sqrt(2 * Math.max(l2, 0)), angle };
}

/** The component whose {@link CONTOUR_SIGMA}σ contour is the drawn ellipse.
 * Variances are floored so even a nearly-collinear scribble yields a proper
 * (sampleable, invertible) Gaussian. */
export function gaussianFromEllipse(e: EllipseShape): Gaussian2D {
  const v1 = Math.max((e.a / CONTOUR_SIGMA) ** 2, MIN_VAR);
  const v2 = Math.max((e.b / CONTOUR_SIGMA) ** 2, MIN_VAR);
  const c = Math.cos(e.angle);
  const s = Math.sin(e.angle);
  return {
    mx: e.cx,
    my: e.cy,
    sxx: v1 * c * c + v2 * s * s,
    sxy: (v1 - v2) * c * s,
    syy: v1 * s * s + v2 * c * c,
  };
}

/** The {@link CONTOUR_SIGMA}σ contour of a component, as display geometry. */
export function ellipseFromGaussian(g: Gaussian2D): EllipseShape {
  const { l1, l2, angle } = eigen2x2(g.sxx, g.sxy, g.syy);
  return {
    cx: g.mx,
    cy: g.my,
    a: CONTOUR_SIGMA * Math.sqrt(Math.max(l1, 0)),
    b: CONTOUR_SIGMA * Math.sqrt(Math.max(l2, 0)),
    angle,
  };
}

/** Normalize an externally-supplied ellipse onto the board: centre clamped
 * inside, axes ordered a ≥ b (rotating the tilt when they swap) and kept in a
 * sane range for the board. */
export function clampEllipse(e: EllipseShape, w: number, h: number): EllipseShape {
  let { a, b, angle } = e;
  a = Math.abs(a);
  b = Math.abs(b);
  if (b > a) {
    [a, b] = [b, a];
    angle += Math.PI / 2;
  }
  const maxAxis = Math.max(w, h) / 2;
  return {
    cx: Math.min(w, Math.max(0, e.cx)),
    cy: Math.min(h, Math.max(0, e.cy)),
    a: Math.min(maxAxis, Math.max(4, a)),
    b: Math.min(maxAxis, Math.max(4, b)),
    angle: Math.atan2(Math.sin(angle), Math.cos(angle)),
  };
}

/** Equal-weight mixture over the drawn components. */
export function mixtureFromEllipses(ellipses: readonly EllipseShape[]): Mixture2D {
  const k = ellipses.length;
  return {
    weights: ellipses.map(() => 1 / k),
    components: ellipses.map(gaussianFromEllipse),
  };
}

// ── sampling ─────────────────────────────────────────────────────────────────

/** Precomputed per-component samplers + the cumulative weight table. */
export function prepareSampler(mix: Mixture2D): {
  chols: Array<{ l11: number; l21: number; l22: number }>;
  cum: number[];
} {
  const chols = mix.components.map(cholesky2x2);
  const cum: number[] = [];
  let acc = 0;
  for (const w of mix.weights) {
    acc += w;
    cum.push(acc);
  }
  cum[cum.length - 1] = 1; // guard float drift so the last component is reachable
  return { chols, cum };
}

/** Draw one point: pick a component by weight, then mean + L·(z₁, z₂). */
export function samplePoint(
  mix: Mixture2D,
  sampler: ReturnType<typeof prepareSampler>,
  rand: () => number,
): Vec2 {
  const u = rand();
  let k = 0;
  while (k < sampler.cum.length - 1 && u > sampler.cum[k]) {
    k++;
  }
  const g = mix.components[k];
  const L = sampler.chols[k];
  const z1 = standardNormal(rand);
  const z2 = standardNormal(rand);
  return { x: g.mx + L.l11 * z1, y: g.my + L.l21 * z1 + L.l22 * z2 };
}

// ── hex binning ──────────────────────────────────────────────────────────────

/** One hexagonal bin: centre (board units) and how many points landed in it. */
export interface HexBin {
  cx: number;
  cy: number;
  count: number;
}

export interface HexBinning {
  bins: HexBin[];
  maxCount: number;
  /** Points inside the [0,w]×[0,h] board (off-board samples are dropped). */
  binned: number;
}

/**
 * Pointy-top hexagonal binning of interleaved-xy data over the board. `r` is
 * the hex circumradius. Off-board points are dropped — samples from a mixture
 * drawn near an edge legitimately land outside the visible board.
 */
export function hexbin(data: Float64Array, r: number, w: number, h: number): HexBinning {
  const counts = new Map<number, { cx: number; cy: number; count: number }>();
  const SQ3 = Math.sqrt(3);
  let binned = 0;
  for (let i = 0; i + 1 < data.length; i += 2) {
    const x = data[i];
    const y = data[i + 1];
    if (x < 0 || x > w || y < 0 || y > h) {
      continue;
    }
    binned++;
    // Axial coordinates for a pointy-top grid, cube-rounded to the nearest hex.
    const qf = ((SQ3 / 3) * x - (1 / 3) * y) / r;
    const rf = ((2 / 3) * y) / r;
    const [q, rr] = roundHex(qf, rf);
    const key = q * 100003 + rr;
    const found = counts.get(key);
    if (found) {
      found.count++;
    } else {
      counts.set(key, { cx: r * SQ3 * (q + rr / 2), cy: r * 1.5 * rr, count: 1 });
    }
  }
  let maxCount = 0;
  const bins: HexBin[] = [];
  for (const b of counts.values()) {
    bins.push(b);
    if (b.count > maxCount) {
      maxCount = b.count;
    }
  }
  return { bins, maxCount, binned };
}

/** Cube-round fractional axial coordinates to the containing hex. */
function roundHex(qf: number, rf: number): [number, number] {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) {
    q = -r - s;
  } else if (dr > ds) {
    r = -q - s;
  }
  return [q, r];
}

/** The vertices of a pointy-top hexagon of circumradius `r` centred at the
 * origin, as an SVG `points` attribute string. */
export function hexPoints(r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

// ── EM ───────────────────────────────────────────────────────────────────────

/**
 * A deliberately naive starting point for EM over `k` components: k-means++-
 * style seeding (first centre a random point, each next the point farthest
 * from every chosen centre), shared covariance = the data's own divided by k.
 * It knows nothing about the drawn components — watching it walk from here to
 * the answer is the demo.
 */
export function initialGuess2d(data: Float64Array, k: number, rand: () => number): Mixture2D {
  const n = data.length / 2;
  let mx = 0;
  let my = 0;
  for (let i = 0; i + 1 < data.length; i += 2) {
    mx += data[i];
    my += data[i + 1];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i + 1 < data.length; i += 2) {
    const dx = data[i] - mx;
    const dy = data[i + 1] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  sxx = Math.max(sxx / n / k, MIN_VAR);
  syy = Math.max(syy / n / k, MIN_VAR);
  sxy = sxy / n / k;

  const centers: Vec2[] = [];
  const first = Math.min(n - 1, Math.floor(rand() * n));
  centers.push({ x: data[2 * first], y: data[2 * first + 1] });
  while (centers.length < k) {
    let best = 0;
    let bestD = -1;
    for (let i = 0; i < n; i++) {
      const x = data[2 * i];
      const y = data[2 * i + 1];
      let d = Number.POSITIVE_INFINITY;
      for (const c of centers) {
        const dd = (x - c.x) ** 2 + (y - c.y) ** 2;
        if (dd < d) {
          d = dd;
        }
      }
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    centers.push({ x: data[2 * best], y: data[2 * best + 1] });
  }

  return {
    weights: centers.map(() => 1 / k),
    components: centers.map((c) => ({ mx: c.x, my: c.y, sxx, sxy, syy })),
  };
}

/**
 * Per-component constants of the entering parameters, shared by the JS E-step
 * and the WebGPU kernel (which uploads exactly these numbers): the inverse
 * covariance and log(w · normalization).
 */
export function eStepPrecompute(
  mix: Mixture2D,
): Array<{ ixx: number; ixy: number; iyy: number; logNorm: number }> {
  return mix.components.map((g, j) => {
    const det = g.sxx * g.syy - g.sxy * g.sxy;
    const safeDet = Math.max(det, 1e-12);
    return {
      ixx: g.syy / safeDet,
      ixy: -g.sxy / safeDet,
      iyy: g.sxx / safeDet,
      logNorm:
        Math.log(Math.max(mix.weights[j], 1e-300)) -
        Math.log(2 * Math.PI) -
        0.5 * Math.log(safeDet),
    };
  });
}

/**
 * The E-step's sufficient statistics, accumulated CENTRALLY — every moment is
 * taken relative to the component's *entering* mean (`sdx = Σ r·(x−mx)`,
 * `sdxx = Σ r·(x−mx)²`, …). Central accumulation is what lets the WebGPU
 * backend sum in f32 without losing the variances to catastrophic
 * cancellation; the JS reference accumulates the same quantities in f64.
 */
export interface EStepSums {
  nk: Float64Array;
  sdx: Float64Array;
  sdy: Float64Array;
  sdxx: Float64Array;
  sdxy: Float64Array;
  sdyy: Float64Array;
  /** Log-likelihood of the entering parameters over the whole data set. */
  logLik: number;
}

/** The JS (f64) E-step: responsibilities via log-sum-exp, central sums. */
export function eStepSums(data: Float64Array, mix: Mixture2D): EStepSums {
  const n = data.length / 2;
  const k = mix.components.length;
  const pre = eStepPrecompute(mix);
  const sums: EStepSums = {
    nk: new Float64Array(k),
    sdx: new Float64Array(k),
    sdy: new Float64Array(k),
    sdxx: new Float64Array(k),
    sdxy: new Float64Array(k),
    sdyy: new Float64Array(k),
    logLik: 0,
  };
  const logp = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    const x = data[2 * i];
    const y = data[2 * i + 1];
    let m = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < k; j++) {
      const g = mix.components[j];
      const dx = x - g.mx;
      const dy = y - g.my;
      const p = pre[j];
      const maha = p.ixx * dx * dx + 2 * p.ixy * dx * dy + p.iyy * dy * dy;
      logp[j] = p.logNorm - 0.5 * maha;
      if (logp[j] > m) {
        m = logp[j];
      }
    }
    let sum = 0;
    for (let j = 0; j < k; j++) {
      sum += Math.exp(logp[j] - m);
    }
    const lse = m + Math.log(sum);
    sums.logLik += lse;
    for (let j = 0; j < k; j++) {
      const g = mix.components[j];
      const r = Math.exp(logp[j] - lse);
      const dx = x - g.mx;
      const dy = y - g.my;
      sums.nk[j] += r;
      sums.sdx[j] += r * dx;
      sums.sdy[j] += r * dy;
      sums.sdxx[j] += r * dx * dx;
      sums.sdxy[j] += r * dx * dy;
      sums.sdyy[j] += r * dy * dy;
    }
  }
  return sums;
}

/**
 * The M-step over central sums: means move by the responsibility-weighted mean
 * offset, covariances come from the central second moments re-centred on the
 * *new* mean. Variances floored at {@link MIN_VAR}; the correlation is clamped
 * so the floor cannot strand the matrix non-positive-definite. A component
 * that captured (almost) no mass keeps its previous shape rather than
 * dividing by zero.
 */
export function mStepFromSums(mix: Mixture2D, n: number, sums: EStepSums): Mixture2D {
  const k = mix.components.length;
  const components: Gaussian2D[] = [];
  const weights: number[] = [];
  for (let j = 0; j < k; j++) {
    if (sums.nk[j] < 1e-6 * n) {
      components.push(mix.components[j]);
      weights.push(sums.nk[j] / n);
      continue;
    }
    const g = mix.components[j];
    const dmx = sums.sdx[j] / sums.nk[j];
    const dmy = sums.sdy[j] / sums.nk[j];
    const vxx = Math.max(sums.sdxx[j] / sums.nk[j] - dmx * dmx, MIN_VAR);
    const vyy = Math.max(sums.sdyy[j] / sums.nk[j] - dmy * dmy, MIN_VAR);
    const lim = 0.99 * Math.sqrt(vxx * vyy);
    const vxy = Math.min(lim, Math.max(-lim, sums.sdxy[j] / sums.nk[j] - dmx * dmy));
    components.push({ mx: g.mx + dmx, my: g.my + dmy, sxx: vxx, sxy: vxy, syy: vyy });
    weights.push(sums.nk[j] / n);
  }
  return { weights, components };
}

/**
 * One EM iteration over interleaved-xy `data`: {@link eStepSums} then
 * {@link mStepFromSums}. `logLik` belongs to the *entering* parameters —
 * which is what makes a monotonically rising sequence the correct thing to
 * watch.
 */
export function emStep2d(
  data: Float64Array,
  mix: Mixture2D,
): { params: Mixture2D; logLik: number } {
  const sums = eStepSums(data, mix);
  return { params: mStepFromSums(mix, data.length / 2, sums), logLik: sums.logLik };
}
