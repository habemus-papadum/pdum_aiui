/**
 * core.ts — pure algorithms for pattern structure analysis.
 *
 * Realm-free (no DOM, no worker globals) so the worker imports it, unit tests
 * exercise it headlessly, and nothing here needs mocking. The worker adds the
 * chunking / progress / cancellation choreography; this module is just math.
 */

export interface SpotCensus {
  /** Number of connected components (spots/stripes) above threshold. */
  count: number;
  /** Component areas in pixels, descending. */
  areas: number[];
  meanArea: number;
  /** Fraction of field covered by the largest component (stripes ≈ large). */
  largestFraction: number;
}

/**
 * Connected-component labeling (4-connectivity, two-pass union-find) of
 * `field > threshold`. The field does NOT wrap here — components touching
 * across the torus seam count separately; fine for a census.
 */
export function labelComponents(
  field: Float32Array,
  width: number,
  height: number,
  threshold: number,
): SpotCensus {
  const n = width * height;
  const labels = new Int32Array(n); // 0 = background, else label id
  const parent: number[] = [0]; // union-find, parent[0] unused
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  let nextLabel = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (field[i] <= threshold) continue;
      const left = x > 0 ? labels[i - 1] : 0;
      const up = y > 0 ? labels[i - width] : 0;
      if (left === 0 && up === 0) {
        labels[i] = nextLabel;
        parent[nextLabel] = nextLabel;
        nextLabel++;
      } else if (left !== 0 && up !== 0) {
        labels[i] = left;
        union(left, up);
      } else {
        labels[i] = left || up;
      }
    }
  }

  const areaByRoot = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (labels[i] === 0) continue;
    const root = find(labels[i]);
    areaByRoot.set(root, (areaByRoot.get(root) ?? 0) + 1);
  }
  const areas = [...areaByRoot.values()].sort((a, b) => b - a);
  const total = areas.reduce((s, a) => s + a, 0);
  return {
    count: areas.length,
    areas,
    meanArea: areas.length > 0 ? total / areas.length : 0,
    largestFraction: total > 0 ? (areas[0] ?? 0) / (width * height) : 0,
  };
}

/** Bin component areas into a log-ish histogram for plotting. */
export function areaHistogram(areas: number[], bins = 12): { area: number; count: number }[] {
  if (areas.length === 0) return [];
  const max = areas[0];
  const edges: number[] = [];
  for (let i = 0; i <= bins; i++) edges.push((max + 1) ** (i / bins));
  const counts = new Array<number>(bins).fill(0);
  for (const a of areas) {
    let b = Math.floor((Math.log(a) / Math.log(max + 1)) * bins);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }
  return counts.map((count, i) => ({
    area: Math.round(Math.sqrt(edges[i] * edges[i + 1])),
    count,
  }));
}

/**
 * Radial autocorrelation of the (mean-removed) field at integer lags
 * 1..maxLag, sampled along x and y. The first prominent maximum after the
 * zero-crossing is the dominant pattern wavelength — the Turing length scale.
 * O(maxLag · n): deliberately the expensive part; the worker chunks it per
 * lag with progress and cancellation between lags.
 */
export function autocorrelationAtLag(
  field: Float32Array,
  width: number,
  height: number,
  mean: number,
  lag: number,
): number {
  let num = 0;
  let den = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const x = i % width;
    const y = (i / width) | 0;
    const c = field[i] - mean;
    den += c * c;
    const xr = field[y * width + ((x + lag) % width)] - mean;
    const yd = field[((y + lag) % height) * width + x] - mean;
    num += c * (xr + yd) * 0.5;
  }
  return den > 0 ? num / den : 0;
}

/** First prominent positive peak after the initial decay = wavelength (px). */
export function dominantWavelength(correlogram: number[]): number | undefined {
  // Skip the initial decay: find the first index where correlation < 0 or a
  // local minimum, then the maximum after it.
  let start = correlogram.findIndex((c) => c <= 0);
  if (start === -1) {
    let minI = 0;
    for (let i = 1; i < correlogram.length; i++) {
      if (correlogram[i] < correlogram[minI]) minI = i;
    }
    start = minI;
  }
  let best = -Infinity;
  let bestLag: number | undefined;
  for (let i = start + 1; i < correlogram.length; i++) {
    if (correlogram[i] > best) {
      best = correlogram[i];
      bestLag = i + 1; // lags are 1-based
    }
  }
  return best > 0.02 ? bestLag : undefined;
}
