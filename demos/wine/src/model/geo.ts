/**
 * geo.ts — pure Equal-Earth projection math for the geographic map view
 * (playbook layer 1), adapted from demos/seismos (the reference
 * implementation; if a third demo needs this, it graduates to aiui-viz).
 *
 * Equal Earth (Šavrič–Patterson–Jenny 2018): equal-AREA, the right family
 * for a density map. The projection is baked into the DATA (eq_x/eq_y table
 * columns computed at load, projected border/graticule vertices), so every
 * plot layer stays in linear x/y space, the DuckDB raster bins in projected
 * (equal-area) space, and the interval brush filters exactly the on-screen
 * rectangle. Constants are the published A1–A4.
 */
import type { IntervalValue } from "@habemus-papadum/aiui-viz/mosaic-selection";

const EE_A1 = 1.340264;
const EE_A2 = -0.081106;
const EE_A3 = 0.000893;
const EE_A4 = 0.003796;
const EE_M = Math.sqrt(3) / 2;

export function equalEarth(lonDeg: number, latDeg: number): { x: number; y: number } {
  const lon = (lonDeg * Math.PI) / 180;
  const theta = Math.asin(EE_M * Math.sin((latDeg * Math.PI) / 180));
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  return {
    x:
      (lon * Math.cos(theta) * (2 * Math.sqrt(3))) /
      (3 * (EE_A1 + 3 * EE_A2 * t2 + t6 * (7 * EE_A3 + 9 * EE_A4 * t2))),
    y: theta * (EE_A1 + EE_A2 * t2 + t6 * (EE_A3 + EE_A4 * t2)),
  };
}

/** Projected extents: x at (±180°, 0°), y at the poles. */
export const EQ_X_MAX = equalEarth(180, 0).x;
export const EQ_Y_MAX = equalEarth(0, 90).y;

/** Equal Earth inverse: projected (x, y) → (lon°, lat°), θ by Newton. */
export function equalEarthInverse(x: number, y: number): { lon: number; lat: number } {
  let theta = y / EE_A1;
  for (let i = 0; i < 12; i++) {
    const t2 = theta * theta;
    const t6 = t2 * t2 * t2;
    const f = theta * (EE_A1 + EE_A2 * t2 + t6 * (EE_A3 + EE_A4 * t2)) - y;
    const fp = EE_A1 + 3 * EE_A2 * t2 + t6 * (7 * EE_A3 + 9 * EE_A4 * t2);
    theta -= f / fp;
  }
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  const deg = 180 / Math.PI;
  const lat = Math.asin(Math.min(1, Math.max(-1, Math.sin(theta) / EE_M))) * deg;
  const lon =
    ((x * 3 * (EE_A1 + 3 * EE_A2 * t2 + t6 * (7 * EE_A3 + 9 * EE_A4 * t2))) /
      (2 * Math.sqrt(3) * Math.cos(theta))) *
    deg;
  return { lon, lat };
}

/**
 * A lon/lat degree box → the projected box that BOUNDS it (the map facet's
 * `to`): x depends on both lon and |lat|, so sample the corner latitudes plus
 * the equator when spanned — the drawn rectangle is the tightest eq-space box
 * containing the requested region, and it is exactly what filters.
 */
export function degreesToEqBox(
  lonV: IntervalValue,
  latV: IntervalValue,
): [[number, number], [number, number]] | null {
  if (lonV == null && latV == null) return null;
  const lonLo = lonV?.lo ?? -180;
  const lonHi = lonV?.hi ?? 180;
  const latLo = latV?.lo ?? -90;
  const latHi = latV?.hi ?? 90;
  const lats = [latLo, latHi];
  if (latLo < 0 && latHi > 0) lats.push(0);
  const xs: number[] = [];
  for (const la of lats) {
    xs.push(equalEarth(lonLo, la).x, equalEarth(lonHi, la).x);
  }
  const y0 = equalEarth(0, latLo).y;
  const y1 = equalEarth(0, latHi).y;
  return [
    [Math.min(...xs), Math.max(...xs)],
    [Math.min(y0, y1), Math.max(y0, y1)],
  ];
}

/** The map facet's `from`: a projected (mouse-drawn) box → the degree box
 * bounding it, one decimal — what the lon/lat dimensions report. */
export function eqBoxToDegrees(cv: unknown): [IntervalValue, IntervalValue] {
  if (cv == null || !Array.isArray(cv)) return [null, null];
  const [xr, yr] = cv as [[number, number], [number, number]];
  const corners = [
    equalEarthInverse(xr[0], yr[0]),
    equalEarthInverse(xr[0], yr[1]),
    equalEarthInverse(xr[1], yr[0]),
    equalEarthInverse(xr[1], yr[1]),
  ];
  if (yr[0] < 0 && yr[1] > 0) {
    corners.push(equalEarthInverse(xr[0], 0), equalEarthInverse(xr[1], 0));
  }
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const lon = (n: number) => Math.min(180, Math.max(-180, r1(n)));
  const lat = (n: number) => Math.min(90, Math.max(-90, r1(n)));
  const lons = corners.map((c) => c.lon);
  const lats = corners.map((c) => c.lat);
  return [
    { lo: lon(Math.min(...lons)), hi: lon(Math.max(...lons)) },
    { lo: lat(Math.min(...lats)), hi: lat(Math.max(...lats)) },
  ];
}
