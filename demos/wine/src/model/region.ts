/**
 * region.ts — the pure value-space transforms for the embedding map's region
 * binding (playbook layer 1): two interval dimensions (projx, projy) ↔ the
 * embedding-atlas Rectangle the view draws. Kept free of the store so the
 * mapping is unit-testable and the binding closures stay signal-free
 * (mosaic-facet's adoption paths must not read Solid signals — the extent is
 * a plain box set once at load).
 */
import type { IntervalValue } from "@habemus-papadum/aiui-viz/mosaic-selection";
import type { Rectangle } from "embedding-atlas";

/** The projection's data-space extent; overwritten at load. */
let projExtent: Rectangle = { xMin: -1, xMax: 1, yMin: -1, yMax: 1 };

export function setProjExtent(extent: Rectangle): void {
  projExtent = extent;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The region binding's `to`: dims → the Rectangle the view draws. An open
 * side widens to the projection extent — a rectangle is never one-sided. */
export function dimsToRect(a: IntervalValue, b: IntervalValue): Rectangle | null {
  if (a == null && b == null) return null;
  return {
    xMin: a?.lo ?? projExtent.xMin,
    xMax: a?.hi ?? projExtent.xMax,
    yMin: b?.lo ?? projExtent.yMin,
    yMax: b?.hi ?? projExtent.yMax,
  };
}

/** The region binding's `from`: a mouse rectangle maps exactly; a freehand
 * lasso (Point[]) mirrors as its bounding box — the published clause keeps
 * the true polygon; the dims (and saved views) carry the box. */
export function rectToDims(cv: unknown): readonly [IntervalValue, IntervalValue] {
  if (cv == null) return [null, null];
  if (Array.isArray(cv)) {
    const pts = cv as { x: number; y: number }[];
    if (pts.length === 0) return [null, null];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return [
      { lo: r3(Math.min(...xs)), hi: r3(Math.max(...xs)) },
      { lo: r3(Math.min(...ys)), hi: r3(Math.max(...ys)) },
    ];
  }
  const r = cv as Rectangle;
  return [
    { lo: r3(r.xMin), hi: r3(r.xMax) },
    { lo: r3(r.yMin), hi: r3(r.yMax) },
  ];
}
