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
import {
  bin,
  colorDomain,
  colorRange,
  colorScale,
  colorScheme,
  count,
  frame,
  from,
  geo,
  height,
  intervalX,
  intervalXY,
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
  yDomain,
  yLabel,
} from "@uwdata/vgplot";
import { plotStyle } from "../../../site/theme";
import { seismic } from "../palette";
import { DEFAULT_MC, store } from "../store";
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
 * The borders are polylines in raw lon/lat — the same identity scale space the
 * raster uses — so a projection-less `geo` mark aligns exactly (see NOTES.md).
 */
export function mapSpec(w = 640, h = 320): Directive[] {
  const p = seismic();
  const world = store.world();
  return [
    raster(from(TABLE(), { filterBy: BRUSH() }), {
      x: "longitude",
      y: "latitude",
      fill: "density",
      pixelSize: 1.5,
    }),
    ...(world.length
      ? [
          geo(world, {
            stroke: p.coast,
            strokeOpacity: p.coastOpacity,
            strokeWidth: 0.5,
            clip: "frame",
          }),
        ]
      : []),
    frame({ stroke: plotStyle().color, strokeOpacity: 0.25 }),
    // A raster is a density aggregation, so its x/y channels don't resolve to a
    // plain column for the brush (getField → null, giving a `NULL BETWEEN …`
    // predicate). Name the geographic fields explicitly so the 2-D brush filters
    // on longitude/latitude.
    intervalXY({ as: BRUSH(), xfield: "longitude", yfield: "latitude" }),
    width(w),
    height(h),
    xDomain([-180, 180]),
    yDomain([-90, 90]),
    colorScale("sqrt"),
    colorScheme(p.densityScheme),
    marginLeft(34),
    marginBottom(24),
    xLabel("longitude"),
    yLabel("latitude"),
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
