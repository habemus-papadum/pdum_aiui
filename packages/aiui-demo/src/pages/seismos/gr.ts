/**
 * gr.ts — the Gutenberg–Richter frequency–magnitude relation, as pure functions
 * over a magnitude histogram. No DuckDB, no Solid: this is the science, unit
 * tested headlessly (gr.test.ts). The graph feeds it the *filtered* histogram
 * from the live DuckDB query (stats-client.ts) and renders the result.
 *
 * The law: the number of earthquakes with magnitude ≥ M in a region/time window
 * follows  log₁₀ N(≥M) = a − b·M.  The slope b (the "b-value") is ~1 for most of
 * the crust; it drops where stress is high (big asperities, deep subduction) and
 * rises in volcanic swarms — so estimating it from the current cross-filter
 * selection is a live geophysical read-out, not decoration.
 *
 * b is estimated by maximum likelihood above the magnitude of completeness Mc —
 * the magnitude above which the catalog is believed to record *every* event.
 * Below Mc the catalog rolls off (small quakes go undetected) and the straight
 * line bends; fitting through that roll-off biases b, so Mc is a first-class
 * input. We use the Aki–Utsu estimator with Bender's binning correction, and the
 * Shi & Bolt (1982) uncertainty.
 */

/** One bin of the incremental frequency–magnitude distribution. */
export interface MagBin {
  /** Bin-center magnitude (catalog magnitudes are reported to 0.1). */
  mag: number;
  /** Number of events in the bin. */
  count: number;
}

/** A point on the cumulative curve: n = number of events with magnitude ≥ mag. */
export interface CumPoint {
  mag: number;
  n: number;
}

export interface GrFit {
  /** Magnitude of completeness used for the fit. */
  mc: number;
  /** Magnitude bin width assumed in the binning correction. */
  dM: number;
  /** The b-value (slope of log₁₀ N vs M). */
  b: number;
  /** 1σ uncertainty on b (Shi & Bolt 1982). */
  sigmaB: number;
  /** The a-value (intercept): log₁₀ N(≥0) implied by the fit. */
  a: number;
  /** Mean magnitude of the complete part of the catalog (M ≥ Mc). */
  meanMag: number;
  /** Event count at or above Mc — the sample the estimate rests on. */
  nComplete: number;
}

const LOG10E = Math.LOG10E; // 0.4342944819…
const EPS = 1e-9;

/** Total number of events across all bins. */
export function totalCount(bins: MagBin[]): number {
  let n = 0;
  for (const b of bins) n += b.count;
  return n;
}

/**
 * The cumulative curve N(≥M), ascending in magnitude. Each point sums its own
 * and all higher bins (a reverse prefix sum). Empty bins still contribute their
 * zero to the running total but emit no point, so the curve carries one point
 * per magnitude that actually occurred — no redundant flat steps on the log plot.
 */
export function cumulative(bins: MagBin[]): CumPoint[] {
  const sorted = [...bins].sort((a, b) => a.mag - b.mag);
  const out: CumPoint[] = [];
  let running = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    running += sorted[i].count;
    if (sorted[i].count > 0) out.push({ mag: sorted[i].mag, n: running });
  }
  out.reverse();
  return out;
}

/**
 * Magnitude of completeness by the maximum-curvature method: the magnitude of
 * the modal bin of the *incremental* distribution (where detection is highest,
 * just above the roll-off). A common practice adds a small correction to this
 * estimate; we return the raw max-curvature value and let the caller offset it.
 * Returns null for an empty histogram.
 */
export function mcMaxCurvature(bins: MagBin[]): number | null {
  let best: MagBin | undefined;
  for (const b of bins) {
    if (b.count > 0 && (best === undefined || b.count > best.count)) best = b;
  }
  return best ? best.mag : null;
}

/**
 * Maximum-likelihood b-value above Mc (Aki 1965; Utsu 1966), with Bender's
 * (1983) correction for magnitudes binned to width dM:
 *
 *   b = log₁₀(e) / ( M̄ − (Mc − dM/2) )
 *
 * where M̄ is the mean magnitude of events with M ≥ Mc. The a-value follows from
 * anchoring the line at N(≥Mc). Uncertainty is Shi & Bolt (1982):
 *
 *   σ_b = 2.30 · b² · √( Σ nᵢ(Mᵢ − M̄)² / (N(N−1)) ).
 *
 * Returns null when fewer than two complete events remain (b is undefined).
 */
export function bValue(bins: MagBin[], mc: number, dM = 0.1): GrFit | null {
  let n = 0;
  let sum = 0;
  for (const bin of bins) {
    if (bin.mag >= mc - EPS && bin.count > 0) {
      n += bin.count;
      sum += bin.mag * bin.count;
    }
  }
  if (n < 2) return null;

  const meanMag = sum / n;
  const denom = meanMag - (mc - dM / 2);
  if (denom <= EPS) return null; // degenerate: all events sit at Mc
  const b = LOG10E / denom;

  let ss = 0; // Σ nᵢ (Mᵢ − M̄)²
  for (const bin of bins) {
    if (bin.mag >= mc - EPS && bin.count > 0) {
      const d = bin.mag - meanMag;
      ss += bin.count * d * d;
    }
  }
  const sigmaB = 2.3 * b * b * Math.sqrt(ss / (n * (n - 1)));
  const a = Math.log10(n) + b * mc;

  return { mc, dM, b, sigmaB, a, meanMag, nComplete: n };
}

/**
 * Two endpoints of the fitted line on the cumulative log-N axis, from Mc to
 * magMax: N(≥M) = 10^(a − b·M). For overlaying the straight GR fit on the
 * cumulative scatter.
 */
export function fitLine(fit: GrFit, magMax: number): CumPoint[] {
  const at = (m: number): CumPoint => ({ mag: m, n: 10 ** (fit.a - fit.b * m) });
  return [at(fit.mc), at(Math.max(magMax, fit.mc + fit.dM))];
}
