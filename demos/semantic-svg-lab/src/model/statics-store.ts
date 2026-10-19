import { action, control } from "@habemus-papadum/aiui-viz";
import { flush } from "solid-js";
import {
  BEAM_FEATURES,
  type BeamFeature,
  LOAD_LIMITS,
  POSITION_LIMITS,
  solveBeam,
} from "./statics";
import { appScope } from "./store";

export const staticsScope = appScope.child("statics");
/** Downward point load W in newtons. The drawing and both equilibrium equations share this control. */
export const load = control({ scope: staticsScope, value: 120, ...LOAD_LIMITS, unit: "N" });
/** Load position along the support span, as a percentage from A toward B. */
export const loadPosition = control({
  scope: staticsScope,
  value: 30,
  ...POSITION_LIMITS,
  unit: "%",
});
/** Hide the support symbols to read the same beam as a free-body diagram. No physical assumption changes. */
export const freeBody = control({ scope: staticsScope, value: false });
export const beamSelection = staticsScope.durableSignal<BeamFeature | null>("selection", null);
export function beamInput() {
  return { load: load.get(), positionPercent: loadPosition.get() };
}
/** Place the load halfway between the supports. */
export const centerLoad = action({
  scope: staticsScope,
  name: "center-load",
  run() {
    flush(() => loadPosition.set(50));
    return solveBeam(beamInput());
  },
});
/** Highlight the same physical quantity in the drawing and equilibrium equations. */
export const selectBeam = action({
  scope: staticsScope,
  name: "select-feature",
  params: { feature: "load, left, right, position, span, or null" },
  run(args) {
    const feature = args?.feature;
    if (feature !== null && !BEAM_FEATURES.includes(feature as BeamFeature))
      throw new Error("Unknown beam feature.");
    flush(() => beamSelection.set(feature as BeamFeature | null));
    return { feature };
  },
});
/** Restore the beam experiment's initial load and position. */
export const resetBeam = action({
  scope: staticsScope,
  name: "reset",
  run() {
    flush(() => {
      load.set(120);
      loadPosition.set(30);
      freeBody.set(false);
      beamSelection.set(null);
    });
    return solveBeam(beamInput());
  },
});
/** Read analytical reactions and floating-point residuals for the stated ideal beam model. */
export const inspectBeam = action({
  scope: staticsScope,
  name: "inspect",
  kind: "read",
  run() {
    flush();
    return {
      ...solveBeam(beamInput()),
      freeBody: freeBody.get(),
      selection: beamSelection.get(),
      units: { force: "N", length: "m", moment: "N m" },
      assumptions: [
        "rigid weightless beam",
        "pin at A",
        "vertical roller at B",
        "one downward point load between supports",
        "no deformation or dynamics",
      ],
    };
  },
});
