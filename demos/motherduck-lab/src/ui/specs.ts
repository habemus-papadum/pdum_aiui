/**
 * specs.ts — the two linked histograms, as vgplot directive lists the
 * MosaicView bridge mounts. Both read `from(view, { filterBy: brush })` — the
 * local VIEW over the cloud table (catalog.ts: a qualified name cannot ride
 * a vgplot mark) — and both publish into the same crossfilter brush. Brush
 * one, the other re-queries; with pre-aggregation on (the default), the cube
 * is built once in the tab's `memory.mosaic` schema (the group-by runs on the
 * Duckling through the view) and every brush after that is a local query.
 */
import { bin, count, from, height, intervalX, rectY, width, xLabel } from "@uwdata/vgplot";
import { store } from "../model/store";
import type { Directive } from "./MosaicView";

export function histogram(view: string, column: string): Directive[] {
  return [
    rectY(from(view, { filterBy: store.brush }), {
      x: bin(column),
      y: count(),
      fill: "steelblue",
      inset: 0.5,
    }),
    intervalX({ as: store.brush }),
    xLabel(column),
    width(640),
    height(180),
  ];
}
