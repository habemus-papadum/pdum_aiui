/**
 * specs.ts — the vgplot specs for the coordinated side panels, as directive
 * lists the MosaicView bridge mounts. Every view's data is
 * `from(TABLE, { filterBy: brush })` and every view carries an interactor
 * publishing INTO that brush (or, for the variety bar, into its own origin
 * relayed into the brush) — brush one view and the coordinator re-queries the
 * rest, the embedding map included. Specs read the per-mode palette live, so
 * a system theme flip rebuilds each island correctly tinted.
 *
 * Every spec takes an optional {@link SpecTheme}: a consuming app mounting
 * this dashboard under its own design system (the FAI pitch deck does)
 * passes its chart palette and plot-root CSS; omitted, both default to this
 * page's per-mode look — the wine app's call sites are unchanged.
 */
import { plotStyle } from "@habemus-papadum/aiui-journal";
import type { Directive } from "@habemus-papadum/aiui-viz/mosaic";
import {
  bin,
  colorDomain,
  colorRange,
  colorScale,
  colorScheme,
  count,
  from,
  height,
  highlight,
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
import { EQ_X_MAX, EQ_Y_MAX, equalEarth } from "../model/geo";
import { store } from "../model/store";
import { type WinePalette, wine } from "../palette";

export type { WinePalette } from "../palette";

/** A consuming app's skin for these specs (see the module header). */
export interface SpecTheme {
  /** Chart palette; default: this page's per-mode `wine()`. */
  palette?: WinePalette;
  /** CSS for the plot root (vgplot `style(...)`); default: journal `plotStyle()`. */
  plotCss?: Record<string, string>;
}

const TABLE = () => store.table;
const BRUSH = () => store.brush;

/** The theme's palette, or this page's per-mode default. */
const pal = (theme: SpecTheme): WinePalette => theme.palette ?? wine();

/** Shared cosmetics for every panel chart (themed, else per-mode). */
function cosmetics(theme: SpecTheme): Directive[] {
  return [style(theme.plotCss ?? plotStyle())];
}

/** One vertex of the 30° graticule / world outline, pre-projected. */
interface GraticulePoint {
  x: number;
  y: number;
  ring: number;
}

/** The 30° graticule and the projection's rounded boundary, built once
 * (seismos pattern: separate point sets — they draw at different opacities,
 * and client-data marks accept only constant channels). */
function buildGraticule(): { grid: GraticulePoint[]; outline: GraticulePoint[] } {
  const grid: GraticulePoint[] = [];
  const outline: GraticulePoint[] = [];
  let ring = 0;
  const push = (arr: GraticulePoint[], lon: number, lat: number) =>
    arr.push({ ...equalEarth(lon, lat), ring });
  for (let lon = -150; lon <= 150; lon += 30) {
    for (let lat = -90; lat <= 90; lat += 2) push(grid, lon, lat);
    ring++;
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = -180; lon <= 180; lon += 2) push(grid, lon, lat);
    ring++;
  }
  for (let lat = -90; lat <= 90; lat += 2) push(outline, -180, lat);
  for (let lon = -180; lon <= 180; lon += 2) push(outline, lon, 90);
  for (let lat = 90; lat >= -90; lat -= 2) push(outline, 180, lat);
  for (let lon = 180; lon >= -180; lon -= 2) push(outline, lon, -90);
  return { grid, outline };
}
const GRATICULE = buildGraticule();

/**
 * The world map: review density on an Equal-Earth projection (baked into the
 * eq_x/eq_y table columns — every layer stays in linear x/y space), with the
 * country-border overlay and a 2-D interval brush publishing a geographic
 * box into the crossfilter. The `xfield`/`yfield` are explicit because a
 * raster's channels don't resolve to plain columns for the brush.
 */
export function mapSpec(w = 720, h = 380, theme: SpecTheme = {}): Directive[] {
  const p = pal(theme);
  const world = store.world();
  return [
    // Reviews concentrate in ~478 small jitter clouds and California alone
    // holds a third of them, so a raw density raster reads as a few pinprick
    // pixels: smooth with a kernel bandwidth so regions glow, and let the
    // sqrt scale keep the Old World visible beside the California maximum.
    raster(from(TABLE(), { filterBy: BRUSH() }), {
      x: "eq_x",
      y: "eq_y",
      fill: "density",
      pixelSize: 2,
      bandwidth: 6,
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
    ...(p.densityRange !== undefined
      ? [colorRange(p.densityRange)]
      : [colorScheme(p.densityScheme)]),
    marginLeft(10),
    marginBottom(10),
    xLabel(null),
    yLabel(null),
    ...cosmetics(theme),
  ];
}

/** Critic-score histogram (80–100) with an interval brush. */
export function pointsHistSpec(w = 320, h = 150, theme: SpecTheme = {}): Directive[] {
  return [
    rectY(from(TABLE(), { filterBy: BRUSH() }), {
      x: bin("points"),
      y: count(),
      fill: pal(theme).hist,
      inset: 0.5,
    }),
    intervalX({ as: BRUSH() }),
    width(w),
    height(h),
    marginLeft(52),
    marginBottom(28),
    xLabel("points →"),
    yLabel("reviews"),
    ...cosmetics(theme),
  ];
}

/** Price histogram, clipped to the readable range (the tail runs to $3300;
 * the brush still filters real prices — an open right edge means "and up").
 * The bin step is EXPLICIT: maxbins spreads over the full data extent, so
 * $3300 ÷ 50 bins put the whole visible $0–200 window inside one bar. */
export function priceHistSpec(w = 320, h = 150, theme: SpecTheme = {}): Directive[] {
  return [
    rectY(from(TABLE(), { filterBy: BRUSH() }), {
      x: bin("price", { step: 5 }),
      y: count(),
      fill: pal(theme).hist,
      inset: 0.5,
    }),
    intervalX({ as: BRUSH() }),
    width(w),
    height(h),
    xDomain([0, 200]),
    marginLeft(52),
    marginBottom(28),
    xLabel("price ($) →"),
    yLabel("reviews"),
    ...cosmetics(theme),
  ];
}

/**
 * The variety bar: top-9 varieties + "other", click-to-toggle, color-keyed to
 * the same categorical palette the embedding map's clusters wear. The toggle
 * publishes into its OWN origin (store.varietySel, relayed into the brush)
 * so the highlight can gray unselected varieties — `highlight` over the
 * crossfilter itself is a silent no-op (categorySelection's docblock).
 */
export function varietyBarSpec(w = 320, h = 240, theme: SpecTheme = {}): Directive[] {
  const classes = store.summary()?.varieties ?? [];
  return [
    rectX(from(TABLE(), { filterBy: BRUSH() }), {
      y: "variety_class",
      x: count(),
      fill: "variety_class",
      inset: 0.5,
    }),
    toggleY({ as: store.varietySel }),
    highlight({ by: store.varietySel, opacity: 0.25 }),
    width(w),
    height(h),
    yDomain(classes),
    colorDomain(classes),
    colorRange(pal(theme).categories),
    marginLeft(158),
    marginBottom(28),
    xLabel("reviews →"),
    yLabel(null),
    ...cosmetics(theme),
  ];
}
