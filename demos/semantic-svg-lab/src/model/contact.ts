/** Circle above the oriented infinite line y=0. All authored lengths lie on a 0.5 mm lattice. */
export const CONTACT_LIMITS = {
  radius: { min: 20, max: 100, step: 0.5 },
  x: { min: -180, max: 180, step: 0.5 },
  height: { min: 0, max: 220, step: 0.5 },
} as const;
export interface ContactPoint {
  x: number;
  y: number;
}
export interface ContactInput {
  position: ContactPoint;
  radius: number;
  locked: boolean;
}
export type ContactFeature = "circle" | "radius" | "height" | "gap" | "normal" | "tangent";
export const CONTACT_FEATURES: ContactFeature[] = [
  "circle",
  "radius",
  "height",
  "gap",
  "normal",
  "tangent",
];

export function snapLength(
  value: number,
  bounds: { min: number; max: number; step: number },
): number {
  if (!Number.isFinite(value)) throw new Error("A length must be finite.");
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value / bounds.step) * bounds.step));
}
function checkLength(value: number, bounds: { min: number; max: number; step: number }) {
  if (
    !Number.isFinite(value) ||
    value < bounds.min ||
    value > bounds.max ||
    !Number.isInteger(value / bounds.step)
  ) {
    throw new Error(`Length must be ${bounds.min}–${bounds.max} mm in ${bounds.step} mm steps.`);
  }
}
export function movePosition(point: ContactPoint, radius: number, locked: boolean): ContactPoint {
  checkLength(radius, CONTACT_LIMITS.radius);
  return {
    x: snapLength(point.x, CONTACT_LIMITS.x),
    y: locked ? radius : snapLength(point.y, CONTACT_LIMITS.height),
  };
}
export function circleLineContact(input: ContactInput) {
  checkLength(input.radius, CONTACT_LIMITS.radius);
  checkLength(input.position.x, CONTACT_LIMITS.x);
  checkLength(input.position.y, CONTACT_LIMITS.height);
  const height = input.locked ? input.radius : input.position.y;
  // These bounded half-integers and their difference are exactly representable as JS numbers.
  // No display tolerance or snap-to-contact epsilon participates in the classification.
  const gap = height - input.radius;
  return {
    radius: input.radius,
    height,
    gap,
    locked: input.locked,
    state:
      gap > 0 ? ("separated" as const) : gap < 0 ? ("crossing" as const) : ("tangent" as const),
    center: { x: input.position.x, y: height },
    lowest: { x: input.position.x, y: gap },
    foot: { x: input.position.x, y: 0 },
    normal: { x: 0, y: 1 },
    tangent: { x: 1, y: 0 },
  };
}
export type ContactResult = ReturnType<typeof circleLineContact>;

export interface ContactViewport {
  width: number;
  height: number;
  scale: number;
  baseline: number;
}
export function contactViewport(width: number, height = 460): ContactViewport {
  const scale = Math.min(width / 620, (height - 60) / 420);
  return { width, height, scale, baseline: height - 30 - 100 * scale };
}
export function contactToScreen(point: ContactPoint, view: ContactViewport): ContactPoint {
  return { x: view.width / 2 + point.x * view.scale, y: view.baseline - point.y * view.scale };
}
export function contactFromScreen(point: ContactPoint, view: ContactViewport): ContactPoint {
  return { x: (point.x - view.width / 2) / view.scale, y: (view.baseline - point.y) / view.scale };
}
