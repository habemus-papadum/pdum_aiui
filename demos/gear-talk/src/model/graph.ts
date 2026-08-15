/**
 * graph.ts — the talk's cell graph over its controls, plus the agent surface.
 *
 * Thin by design (the gears pattern): cells gather control values into a deps
 * bundle — the one place a dependency is declared — and hand them to
 * demo-gears' pure geometry. Wrapping as cells buys attribution, the agent
 * `report`, and one shared computation for every slide that draws a gear:
 * the anatomy slide's tooth, the mesh slide's pair, and the design slide's
 * readouts all read THESE cells, which is what makes a Lens-adjusted control
 * visibly propagate across slides.
 */
import { agentToolkit, cell, hotCellGraph, registerStandardTools } from "@habemus-papadum/aiui-viz";
import {
  type GearGeometry,
  gearGeometry,
  type MeshGeometry,
  meshGeometry,
} from "@habemus-papadum/demo-gears/gear";
import { addendum, dedendum, pressureAngle, talkScope, teethA, teethB } from "./store";

/** The talk draws at a fixed module — tooth size is presentation, not a knob
 * the narrative needs (the gears NOTEBOOK is where you play with module). */
export const MODULE = 8;

function commonParams(): {
  module: number;
  pressureAngle: number;
  addendum: number;
  dedendum: number;
} {
  return {
    module: MODULE,
    pressureAngle: pressureAngle.get(),
    addendum: addendum.get(),
    dedendum: dedendum.get(),
  };
}

export const graph = hotCellGraph(
  "gear-talk",
  () => {
    /** Geometry of the driving gear (design-slide pair, anatomy tooth). */
    const gearA = cell(
      () => ({ teeth: teethA.get(), ...commonParams() }),
      (p): GearGeometry => gearGeometry(p),
      { scope: talkScope },
    );

    /** Geometry of the driven gear. */
    const gearB = cell(
      () => ({ teeth: teethB.get(), ...commonParams() }),
      (p): GearGeometry => gearGeometry(p),
      { scope: talkScope },
    );

    /** Meshing geometry: centre distance, line of action, contact ratio. */
    const mesh = cell(
      () => ({ a: gearA(), b: gearB() }),
      ({ a, b }): MeshGeometry => meshGeometry(a, b),
      { scope: talkScope },
    );

    /** Everything a pair-drawing view needs in one settled bundle (the gears
     *  notebook's `scene` shape), so figures receive plain data. */
    const scene = cell(
      () => ({ a: gearA(), b: gearB(), m: mesh() }),
      ({ a, b, m }) => ({ a, b, mesh: m }),
      { scope: talkScope },
    );

    return { gearA, gearB, mesh, scene };
  },
  import.meta.hot,
);

export type TalkGraph = ReturnType<typeof graph>;

// --- the agent surface ------------------------------------------------------
// One kit for the whole talk: the store's controls, these cells, AND the deck
// model's slide control + next/prev verbs (../deck.ts — same scope), so the
// agent can drive the presentation ("next slide") and its content ("set the
// pressure angle to 25") through one toolkit.
const kit = agentToolkit("gear-talk");
registerStandardTools(kit);
