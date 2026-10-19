import { action, control } from "@habemus-papadum/aiui-viz";
import { flush } from "solid-js";
import {
  checkPose,
  circlePair,
  normalizeAngle,
  PAIR_FEATURES,
  PAIR_RADIUS,
  type PairFeature,
  type PairPose,
  poseFromPoint,
} from "./circle-pair";
import { appScope } from "./store";

export const pairScope = appScope.child("pair");
/** Radius of fixed-centre circle A, in millimetres. */
export const radiusA = control({ scope: pairScope, value: 70, ...PAIR_RADIUS, unit: "mm" });
/** Radius of movable circle B, in millimetres. */
export const radiusB = control({ scope: pairScope, value: 45, ...PAIR_RADIUS, unit: "mm" });
/** Presentation scale only; contact calculations never read it. */
export const pairZoom = control({ scope: pairScope, value: 2, min: 0.5, max: 3, step: 0.1 });
export const pairPose = pairScope.durableSignal<PairPose>("pose", { distance: 170, angle: 45 });
export const pairHeld = pairScope.durableSignal("held", false);
export const pairSelection = pairScope.durableSignal<PairFeature | null>("selection", null);
export function pairInput() {
  return {
    radiusA: radiusA.get(),
    radiusB: radiusB.get(),
    pose: pairPose.get(),
    held: pairHeld.get(),
  };
}
function writePose(next: PairPose) {
  flush(() =>
    pairPose.set((previous) =>
      previous.distance === next.distance && previous.angle === next.angle ? previous : next,
    ),
  );
  return circlePair(pairInput());
}
/** Move B relative to fixed A. With tangency held, this chooses bearing while distance stays rA+rB. */
export const movePair = action({
  scope: pairScope,
  name: "move-circle",
  params: { x: "B centre x in mm relative to A", y: "B centre y in mm relative to A" },
  run(args) {
    flush();
    if (typeof args?.x !== "number" || typeof args.y !== "number")
      throw new Error("Supply numeric x and y.");
    return writePose(
      poseFromPoint(
        { x: args.x, y: args.y },
        pairPose.get(),
        radiusA.get() + radiusB.get(),
        pairHeld.get(),
      ),
    );
  },
});
/** Set polar parameters directly. Bearing snaps to whole degrees; held tangency determines distance.
 * @example {"distance":100,"angle":45}
 */
export const setPairPose = action({
  scope: pairScope,
  name: "set-pose",
  params: { distance: "0–240 mm in 0.5 mm steps", angle: "Bearing in degrees" },
  run(args) {
    flush();
    if (typeof args?.distance !== "number" || typeof args.angle !== "number")
      throw new Error("Supply numeric distance and angle.");
    const pose = { distance: args.distance, angle: normalizeAngle(args.angle) };
    checkPose(pose);
    return writePose({
      ...pose,
      distance: pairHeld.get() ? radiusA.get() + radiusB.get() : pose.distance,
    });
  },
});
/** Hold or release external tangency. Coincident centres require choosing a direction first. */
export const holdPair = action({
  scope: pairScope,
  name: "hold-tangency",
  params: { enabled: "Whether external tangency is maintained" },
  run(args) {
    flush();
    if (typeof args?.enabled !== "boolean") throw new Error("enabled must be boolean.");
    const current = circlePair(pairInput());
    if (args.enabled && !current.normal)
      throw new Error("Move B away from A to choose a contact direction first.");
    const enabled = args.enabled;
    flush(() => {
      pairPose.set({ distance: enabled ? current.sum : current.distance, angle: current.angle });
      pairHeld.set(enabled);
    });
    return circlePair(pairInput());
  },
});
/** Place B at external tangency once, retaining free movement. */
export const touchPair = action({
  scope: pairScope,
  name: "touch-once",
  run() {
    flush();
    const current = circlePair(pairInput());
    if (!current.normal) throw new Error("Move B away from A to choose a contact direction first.");
    flush(() => {
      pairPose.set({ distance: current.sum, angle: current.angle });
      pairHeld.set(false);
    });
    return circlePair(pairInput());
  },
});
/** Select a geometric feature across the drawing and equations. */
export const selectPair = action({
  scope: pairScope,
  name: "select-feature",
  params: { feature: "a, b, distance, gap, normal, tangent, or null" },
  run(args) {
    const feature = args?.feature;
    if (feature !== null && !PAIR_FEATURES.includes(feature as PairFeature))
      throw new Error("Unknown pair feature.");
    flush(() => pairSelection.set(feature as PairFeature | null));
    return { feature };
  },
});
/** Restore the separated-circle example. */
export const resetPair = action({
  scope: pairScope,
  name: "reset",
  run() {
    flush(() => {
      radiusA.set(70);
      radiusB.set(45);
      pairZoom.set(2);
      pairPose.set({ distance: 170, angle: 45 });
      pairHeld.set(false);
      pairSelection.set(null);
    });
    return circlePair(pairInput());
  },
});
/** Inspect circle relations, contact witnesses and the distinction between authored parameters and numerical constructions. */
export const inspectPair = action({
  scope: pairScope,
  name: "inspect",
  kind: "read",
  run() {
    flush();
    return {
      ...circlePair(pairInput()),
      selection: pairSelection.get(),
      units: "mm",
      precision:
        "relations from half-millimetre polar distance/radii; bearing in whole degrees; Cartesian points are numerical approximations",
    };
  },
});
/** Align the centres and release tangency, exposing the undefined-normal case. */
export const alignPair = action({
  scope: pairScope,
  name: "align-centres",
  run() {
    flush();
    const angle = pairPose.get().angle;
    flush(() => {
      pairPose.set({ distance: 0, angle });
      pairHeld.set(false);
    });
    return circlePair(pairInput());
  },
});
