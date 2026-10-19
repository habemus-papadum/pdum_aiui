/** Polar-authored circles. A is fixed at the origin; B has a distance and bearing. */
export const PAIR_RADIUS = { min: 20, max: 90, step: 0.5 } as const;
export const MAX_DISTANCE = 240;
export interface PairPoint {
  x: number;
  y: number;
}
export interface PairPose {
  distance: number;
  angle: number;
}
export interface PairInput {
  radiusA: number;
  radiusB: number;
  pose: PairPose;
  held: boolean;
}
export type PairRelation =
  | "separated"
  | "external-tangent"
  | "intersecting"
  | "internal-tangent"
  | "contained"
  | "coincident";
export type PairFeature = "a" | "b" | "distance" | "gap" | "normal" | "tangent";
export const PAIR_FEATURES: PairFeature[] = ["a", "b", "distance", "gap", "normal", "tangent"];
function checkRadius(radius: number) {
  if (
    !Number.isFinite(radius) ||
    radius < PAIR_RADIUS.min ||
    radius > PAIR_RADIUS.max ||
    !Number.isInteger(radius * 2)
  )
    throw new Error("Radii must be 20–90 mm in 0.5 mm steps.");
}
export function normalizeAngle(angle: number): number {
  if (!Number.isFinite(angle)) throw new Error("Bearing must be finite.");
  return ((((Math.round(angle) + 180) % 360) + 360) % 360) - 180;
}
export function checkPose(pose: PairPose): void {
  if (
    !Number.isFinite(pose.distance) ||
    pose.distance < 0 ||
    pose.distance > MAX_DISTANCE ||
    !Number.isInteger(pose.distance * 2)
  )
    throw new Error("Distance must be 0–240 mm in 0.5 mm steps.");
  if (!Number.isInteger(pose.angle) || pose.angle < -180 || pose.angle >= 180)
    throw new Error("Bearing must be an integer in [-180, 180) degrees.");
}
/** Map a pointer proposal to authored polar parameters; the origin supplies no new bearing. */
export function poseFromPoint(
  point: PairPoint,
  previous: PairPose,
  radiusSum: number,
  held: boolean,
): PairPose {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    throw new Error("Supply finite coordinates.");
  const length = Math.hypot(point.x, point.y);
  return {
    distance: held ? radiusSum : Math.min(MAX_DISTANCE, Math.round(length * 2) / 2),
    angle:
      length === 0
        ? previous.angle
        : normalizeAngle((Math.atan2(point.y, point.x) * 180) / Math.PI),
  };
}
export function circlePair(input: PairInput) {
  checkRadius(input.radiusA);
  checkRadius(input.radiusB);
  checkPose(input.pose);
  const sum = input.radiusA + input.radiusB;
  const difference = Math.abs(input.radiusA - input.radiusB);
  const distance = input.held ? sum : input.pose.distance;
  const gap = distance - sum;
  const relation: PairRelation =
    distance === 0 && difference === 0
      ? "coincident"
      : distance > sum
        ? "separated"
        : distance === sum
          ? "external-tangent"
          : distance < difference
            ? "contained"
            : distance === difference
              ? "internal-tangent"
              : "intersecting";
  const radians = (input.pose.angle * Math.PI) / 180;
  const direction = { x: Math.cos(radians), y: Math.sin(radians) };
  const pointAt = (length: number): PairPoint => ({
    x: length * direction.x,
    y: length * direction.y,
  });
  const centerA = { x: 0, y: 0 };
  const centerB = pointAt(distance);
  const normal = distance === 0 ? null : direction;
  const tangent = normal ? { x: -normal.y, y: normal.x } : null;
  // These face each other along the centre line; they are not closest-boundary witnesses in containment.
  const facingA = normal ? pointAt(input.radiusA) : null;
  const facingB = normal ? pointAt(distance - input.radiusB) : null;
  let contactPoint: PairPoint | null = null;
  if (relation === "external-tangent") contactPoint = pointAt(input.radiusA);
  if (relation === "internal-tangent")
    contactPoint = pointAt(input.radiusA >= input.radiusB ? input.radiusA : -input.radiusA);
  const crossings: PairPoint[] = [];
  if (relation === "intersecting" && tangent) {
    const along = (input.radiusA ** 2 - input.radiusB ** 2 + distance ** 2) / (2 * distance);
    const heightSquared = input.radiusA ** 2 - along ** 2;
    if (heightSquared <= 0) throw new Error("Intersection construction is unresolved.");
    const height = Math.sqrt(heightSquared);
    const base = pointAt(along);
    crossings.push(
      { x: base.x + height * tangent.x, y: base.y + height * tangent.y },
      { x: base.x - height * tangent.x, y: base.y - height * tangent.y },
    );
  }
  return {
    radiusA: input.radiusA,
    radiusB: input.radiusB,
    distance,
    angle: input.pose.angle,
    sum,
    gap,
    held: input.held,
    relation,
    centerA,
    centerB,
    normal,
    tangent,
    facingA,
    facingB,
    contactPoint,
    crossings,
  };
}
export type PairResult = ReturnType<typeof circlePair>;
export function pairViewport(width: number, height = 500, zoom = 1) {
  return {
    width,
    height,
    scale: Math.min((width - 40) / 700, (height - 100) / 700) * zoom,
    origin: { x: width / 2, y: height / 2 - 8 },
  };
}
export type PairViewport = ReturnType<typeof pairViewport>;
export function pairToScreen(point: PairPoint, view: PairViewport): PairPoint {
  return { x: view.origin.x + point.x * view.scale, y: view.origin.y - point.y * view.scale };
}
export function pairFromScreen(point: PairPoint, view: PairViewport): PairPoint {
  return { x: (point.x - view.origin.x) / view.scale, y: (view.origin.y - point.y) / view.scale };
}
