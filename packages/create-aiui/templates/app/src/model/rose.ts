// <aiui-scenery-file> — this WHOLE FILE is placeholder scenery: delete it on reset (CLAUDE.md § Reset).
/**
 * rose.ts — pure math, no framework: the placeholder picture.
 *
 * A Maurer rose: take the polar rose r = sin(n·θ), visit it at θ = 0°, d°,
 * 2d°, … 360·d°, and connect the 361 visited points with straight lines. Tiny
 * changes to the step d rearrange the whole figure — which is exactly what a
 * "one slider, one picture" starter wants.
 */

export interface RoseParams {
  /** Petal frequency n of r = sin(n·θ). */
  petals: number;
  /** The walk's angle step d, in degrees. */
  step: number;
}

export interface Rose {
  /** SVG path of the 361-segment Maurer walk. */
  walk: string;
  /** SVG path of the underlying rose curve, smoothly sampled. */
  outline: string;
}

const DEG = Math.PI / 180;

function point(n: number, thetaDeg: number): string {
  const theta = thetaDeg * DEG;
  const r = Math.sin(n * theta);
  return `${(r * Math.cos(theta)).toFixed(4)},${(r * Math.sin(theta)).toFixed(4)}`;
}

export function buildRose({ petals: n, step: d }: RoseParams): Rose {
  const walk: string[] = [];
  for (let k = 0; k <= 360; k++) {
    walk.push(point(n, k * d));
  }
  const outline: string[] = [];
  for (let k = 0; k <= 720; k++) {
    outline.push(point(n, k / 2));
  }
  return {
    walk: `M${walk.join("L")}`,
    outline: `M${outline.join("L")}Z`,
  };
}
