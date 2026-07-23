/**
 * graph.ts — Layer 2 (disposable side): the cell graph over the gear controls,
 * plus the agent tool surface. `hotCellGraph` rebuilds this over the durable
 * roots on every hot edit; components read cells through the `graph()` accessor.
 *
 * The gear math (model/gear.ts) is pure and synchronous, so these cells are
 * thin: they gather the control values into a deps bundle — the one place a
 * dependency is declared — and hand them to the pure builders. Wrapping the
 * geometry as cells buys attribution (`data-cell`), the agent `report`, and the
 * CellView chrome; the per-input probe in graph.test.ts guards the deps bundles.
 */
import {
  action,
  agentToolkit,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { type GearGeometry, type GearParams, gearGeometry, meshGeometry } from "./gear";
import {
  addendum,
  dedendum,
  driveAngle,
  gearsScope,
  module,
  pressureAngle,
  teethA,
  teethB,
} from "./store";

/** Common (both gears share module, pressure angle, and addendum/dedendum). */
function commonParams(): Omit<GearParams, "teeth"> {
  return {
    module: module.get(),
    pressureAngle: pressureAngle.get(),
    addendum: addendum.get(),
    dedendum: dedendum.get(),
  };
}

export const graph = hotCellGraph(
  "gears",
  () => {
    /** Geometry of the driving gear (gear A), rebuilt when its parameters move. */
    const gearA = cell(
      () => ({ teeth: teethA.get(), ...commonParams() }),
      (p): GearGeometry => gearGeometry(p),
      { scope: gearsScope },
    );

    /** Geometry of the driven gear (gear B). */
    const gearB = cell(
      () => ({ teeth: teethB.get(), ...commonParams() }),
      (p): GearGeometry => gearGeometry(p),
      { scope: gearsScope },
    );

    /** Meshing geometry: centre distance, line of action, path of contact,
     *  base pitch and contact ratio for the current pair. */
    const mesh = cell(
      () => ({ a: gearA(), b: gearB() }),
      ({ a, b }) => meshGeometry(a, b),
      { scope: gearsScope },
    );

    /** Everything the assembly view needs in one settled bundle, so the
     *  imperative SVG island receives plain data instead of reading cells. */
    const scene = cell(
      () => ({ a: gearA(), b: gearB(), m: mesh() }),
      ({ a, b, m }) => ({ a, b, mesh: m }),
      { scope: gearsScope },
    );

    return { gearA, gearB, mesh, scene };
  },
  import.meta.hot,
);

/** The graph's shape, inferred — components type against it. */
export type AppGraph = ReturnType<typeof graph>;

// --- the agent surface ------------------------------------------------------

const kit = agentToolkit("gears");
registerStandardTools(kit);

/** Reset the drive angle to zero (return the mesh to its home position). */
action({
  scope: gearsScope,
  name: "reset",
  run: () => {
    driveAngle.set(0);
    return { driveAngle: 0 };
  },
});
