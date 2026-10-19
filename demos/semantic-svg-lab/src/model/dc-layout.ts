import { PARTS, type PartId, type PinId, type Wire } from "./dc-circuit";
export interface DCPoint {
  x: number;
  y: number;
}
export type DCLayout = Record<PartId, DCPoint>;
export const DC_SIZE = { width: 720, height: 460 };
export function initialDCLayout(): DCLayout {
  return {
    V1: { x: 140, y: 220 },
    R1: { x: 350, y: 140 },
    R2: { x: 350, y: 290 },
    RL: { x: 550, y: 290 },
  };
}
export function moveDCPart(layout: DCLayout, part: PartId, x: number, y: number): DCLayout {
  if (!PARTS.includes(part) || !Number.isFinite(x) || !Number.isFinite(y))
    throw new Error("Choose a component and finite drawing coordinates.");
  return {
    ...layout,
    [part]: {
      x: Math.round(Math.max(80, Math.min(600, x)) / 10) * 10,
      y: Math.round(Math.max(100, Math.min(330, y)) / 10) * 10,
    },
  };
}
export function pinPosition(layout: DCLayout, pin: PinId): DCPoint {
  const [part, end] = pin.split("/") as [PartId, string];
  const center = layout[part];
  return {
    x: center.x,
    y: center.y + (end === "a" || end === "p" ? -1 : 1) * (part === "V1" ? 60 : 50),
  };
}
/** Simple orthogonal display routing. Crossings and visual overlaps never mutate connectivity. */
export function wirePoints(layout: DCLayout, wire: Pick<Wire, "a" | "b">): DCPoint[] {
  const a = pinPosition(layout, wire.a),
    b = pinPosition(layout, wire.b);
  const top = (pin: PinId) => pin.endsWith("/a") || pin.endsWith("/p");
  const rail =
    top(wire.a) === top(wire.b)
      ? top(wire.a)
        ? Math.min(a.y, b.y) - 35
        : Math.max(a.y, b.y) + 35
      : (a.y + b.y) / 2;
  if (wire.a.split("/")[0] === wire.b.split("/")[0])
    return [a, { x: a.x - 60, y: a.y }, { x: b.x - 60, y: b.y }, b];
  if (a.x === b.x) return [a, b];
  return [a, { x: a.x, y: rail }, { x: b.x, y: rail }, b];
}
export function wirePath(layout: DCLayout, wire: Pick<Wire, "a" | "b">) {
  return wirePoints(layout, wire)
    .map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`)
    .join(" ");
}
export function wireLabelPosition(layout: DCLayout, wire: Pick<Wire, "a" | "b">) {
  const points = wirePoints(layout, wire);
  const a = points.length === 2 ? points[0] : points[1],
    b = points.length === 2 ? points[1] : points[2];
  return {
    x: (a.x + b.x) / 2 + (points.length === 2 ? -28 : 8),
    y: (a.y + b.y) / 2 + (points.length === 2 ? 0 : -8),
  };
}
