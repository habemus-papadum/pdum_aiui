/**
 * specs.ts — the vgplot specs for the coordinated views, as plain directive
 * lists the MosaicView bridge mounts. Kept out of the components so the grammar
 * reads in one place and the per-mode cosmetics have a single source.
 *
 * Every view's data is `from(TABLE, { filterBy: brush })` — the shared
 * crossfilter selection — and every view carries an interactor that publishes
 * *into* that same brush (`intervalX`, `intervalXY`, `toggleY`). That is the
 * whole cross-filter wiring: brush one view, the coordinator re-queries the rest
 * (each excluding its own clause), and they update in lockstep. The derived
 * numbers (b-value, counts) ride the same selection through the stats-client.
 *
 * Specs read the per-mode palette live, so the MosaicView effect rebuilds the
 * island on a system theme flip (chart text/marks re-tint correctly).
 */

import { plotStyle } from "@habemus-papadum/aiui-journal";
import {
  bin,
  colorDomain,
  colorRange,
  colorScale,
  colorScheme,
  count,
  from,
  height,
  intervalX,
  intervalXY,
  line,
  marginBottom,
  marginLeft,
  raster,
  rectX,
  rectY,
  style,
  toggleY,
  width,
  xDomain,
  xLabel,
  xTicks,
  yDomain,
  yLabel,
  yTicks,
} from "@uwdata/vgplot";
import { seismic } from "../palette";
import { DEFAULT_MC, EQ_X_MAX, EQ_Y_MAX, equalEarth, store } from "../store";
import type { Directive } from "./MosaicView";

const TABLE = () => store.table;
const BRUSH = () => store.brush;

/** Shared per-mode cosmetics for every panel chart. */
function cosmetics(): Directive[] {
  return [style(plotStyle())];
}

/**
 * The epicenter density map — the Ring of Fire drawn by the data. A raster
 * aggregates the ~270k points server-side in DuckDB (fast, unlike 270k SVG
 * dots), colored by a per-mode sequential density scheme on a sqrt scale
 * (epicenter density is extremely skewed). A 2-D interval brush publishes a
 * lon/lat box into the crossfilter.
 *
 * Two legibility choices: `pixelSize` 1.5 makes each density cell ~50% larger,
 * so the sparse, isolated events (most of Earth's crust is aseismic) read as
 * visible specks rather than single pixels; and a faint country-border overlay
 * (drawn *over* the opaque raster, since its near-black density floor otherwise
 * hides any layer behind it) gives that sparse scatter geographic anchoring.
 * The borders are polylines drawn as a `line` mark (one ring per `z` series) —
 * the same x/y scale space the raster uses, so they align exactly. NOT a `geo`
 * mark: vgplot's geo, given literal features on a projection-less plot,
 * silently renders nothing (see NOTES.md).
 *
 * The map is an Equal Earth projection with LINEAR scales: both coordinates are
 * pre-projected (eq_x/eq_y table columns for the raster and brush, transformed
 * vertices for borders and graticule), so the projection costs the plot nothing
 * — and the brush's `eq_x/eq_y BETWEEN` predicate filters exactly the on-screen
 * rectangle the user drew (equalEarth in store.ts). Since projected x mixes
 * lon and lat, the axes carry no honest tick labels; the graticule (30° grid +
 * the rounded world outline) is the georeference instead.
 */

/** One vertex of the 30° graticule / world outline, pre-projected. */
interface GraticulePoint {
  x: number;
  y: number;
  ring: number;
}

/**
 * The 30° graticule and the projection's rounded boundary, built once — as two
 * separate point sets because they draw at different opacities and vgplot's
 * client-data marks accept only constant (or column-name) channels: a
 * function-valued channel silently hangs the mark's update (learned live).
 */
function buildGraticule(): { grid: GraticulePoint[]; outline: GraticulePoint[] } {
  const grid: GraticulePoint[] = [];
  const outline: GraticulePoint[] = [];
  let ring = 0;
  const push = (arr: GraticulePoint[], lon: number, lat: number) =>
    arr.push({ ...equalEarth(lon, lat), ring });
  // Interior meridians every 30°, pole to pole.
  for (let lon = -150; lon <= 150; lon += 30) {
    for (let lat = -90; lat <= 90; lat += 2) push(grid, lon, lat);
    ring++;
  }
  // Interior parallels every 30° (the equatorial band; poles are the outline's).
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = -180; lon <= 180; lon += 2) push(grid, lon, lat);
    ring++;
  }
  // The world outline: ±180° meridians joined by the flat pole lines — the
  // rounded silhouette that makes the projection legible as a globe.
  for (let lat = -90; lat <= 90; lat += 2) push(outline, -180, lat);
  for (let lon = -180; lon <= 180; lon += 2) push(outline, lon, 90);
  for (let lat = 90; lat >= -90; lat -= 2) push(outline, 180, lat);
  for (let lon = 180; lon >= -180; lon -= 2) push(outline, lon, -90);
  return { grid, outline };
}
const GRATICULE = buildGraticule();

export function mapSpec(w = 640, h = 350): Directive[] {
  const p = seismic();
  const world = store.world();
  return [
    raster(from(TABLE(), { filterBy: BRUSH() }), {
      x: "eq_x",
      y: "eq_y",
      fill: "density",
      pixelSize: 1.5,
    }),
    ...(world.length
      ? [
          line(world, {
            x: "x",
            y: "y",
            z: "ring",
            stroke: p.coast,
            strokeOpacity: p.coastOpacity,
            strokeWidth: 0.5,
            clip: "frame",
          }),
        ]
      : []),
    // A raster is a density aggregation, so its x/y channels don't resolve to a
    // plain column for the brush (getField → null, giving a `NULL BETWEEN …`
    // predicate). Name the geographic fields explicitly so the 2-D brush filters
    // on longitude/latitude.
    // The graticule + rounded world outline, in place of axis chrome (projected
    // x has no single longitude, so tick labels would lie).
    line(GRATICULE.grid, {
      x: "x",
      y: "y",
      z: "ring",
      stroke: p.coast,
      strokeOpacity: p.coastOpacity * 0.45,
      strokeWidth: 0.5,
    }),
    line(GRATICULE.outline, {
      x: "x",
      y: "y",
      stroke: p.coast,
      strokeOpacity: p.coastOpacity,
      strokeWidth: 0.8,
    }),
    intervalXY({ as: BRUSH(), xfield: "eq_x", yfield: "eq_y" }),
    width(w),
    height(h),
    xDomain([-EQ_X_MAX * 1.02, EQ_X_MAX * 1.02]),
    yDomain([-EQ_Y_MAX * 1.03, EQ_Y_MAX * 1.03]),
    xTicks([]),
    yTicks([]),
    colorScale("sqrt"),
    colorScheme(p.densityScheme),
    marginLeft(34),
    marginBottom(24),
    xLabel(null),
    yLabel(null),
    ...cosmetics(),
  ];
}

/** A binned histogram over a numeric column with an interval brush. */
function histSpec(field: string, label: string, w: number, h: number): Directive[] {
  return [
    rectY(from(TABLE(), { filterBy: BRUSH() }), {
      x: bin(field),
      y: count(),
      fill: seismic().hist,
      inset: 0.5,
    }),
    intervalX({ as: BRUSH() }),
    width(w),
    height(h),
    marginLeft(46),
    marginBottom(28),
    xLabel(label),
    yLabel("events"),
    ...cosmetics(),
  ];
}

/** Magnitude histogram — the raw shape the Gutenberg–Richter law describes. */
export function magHistSpec(w = 320, h = 168): Directive[] {
  return histSpec("mag", "magnitude M →", w, h);
}

/** Depth histogram — the shallow spike plus the deep-focus (subduction) tail. */
export function depthHistSpec(w = 320, h = 168): Directive[] {
  return histSpec("depth", "depth (km) →", w, h);
}

/** Time histogram — binned on the timestamp; the rising trend is mostly the
 *  growth of the detection network, not of seismicity (see prose). */
export function timeHistSpec(w = 320, h = 168): Directive[] {
  return [
    rectY(from(TABLE(), { filterBy: BRUSH() }), {
      x: bin("time"),
      y: count(),
      fill: seismic().hist,
      inset: 0.5,
    }),
    intervalX({ as: BRUSH() }),
    width(w),
    height(h),
    marginLeft(46),
    marginBottom(28),
    xLabel("year →"),
    yLabel("events"),
    ...cosmetics(),
  ];
}

/**
 * Depth class as a categorical bar (shallow / intermediate / deep), color-keyed
 * to the ordered palette, click-to-toggle into the crossfilter. The one view
 * where color carries meaning — identity backed by the fixed y-order too.
 */
export function depthClassSpec(w = 320, h = 132): Directive[] {
  const p = seismic();
  return [
    rectX(from(TABLE(), { filterBy: BRUSH() }), {
      y: "depth_class",
      x: count(),
      fill: "depth_class",
      inset: 1,
    }),
    toggleY({ as: BRUSH() }),
    width(w),
    height(h),
    yDomain(["shallow", "intermediate", "deep"]),
    colorDomain(["shallow", "intermediate", "deep"]),
    colorRange([p.shallow, p.intermediate, p.deep]),
    marginLeft(84),
    marginBottom(28),
    xLabel("events →"),
    yLabel(null),
    ...cosmetics(),
  ];
}

/** Re-exported for the controls' "reset Mc" affordance. */
export { DEFAULT_MC };
