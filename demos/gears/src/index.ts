/**
 * @habemus-papadum/demo-gears — the involute-gear studio as a LIBRARY: its
 * store surface, cell graph accessor, widgets, and the pure gear geometry,
 * importable by any workspace sibling (the gallery composes the ./page subpath;
 * this barrel is for finer-grained reuse).
 *
 * Identity is scoped: every control, durable, cell, and action is qualified
 * under `gearsScope` ("gears/teethA", window.__gears…), so this demo coexists
 * in one document with the other demos — the aiui composability model (aiui-viz
 * scope.ts; user guide, "Composing bigger apps"). The widgets and graph read
 * the ONE module-level instance (an app that exports its parts, not a
 * multi-instance slice factory — see demos/oscillator for that pattern).
 *
 * Importing THIS barrel boots the app: it re-exports the graph and store, so
 * their side effects (cells, toolkit) run. A sibling that wants only the pure
 * geometry — demo-gear-talk's figures, a landing card — imports the `./gear`
 * subpath instead, which carries no identity and registers nothing.
 */

// --- pure model (playbook layer 1) ------------------------------------------
export {
  addendumRadius,
  baseRadius,
  contactPoints,
  deg2rad,
  type GearGeometry,
  type GearParams,
  gearGeometry,
  type MeshGeometry,
  meshGeometry,
  type Pt,
  pitchRadius,
  rad2deg,
  rootRadius,
  toPathD,
} from "./model/gear";

// --- the cell graph (model/graph.ts) ----------------------------------------
export { type AppGraph, graph } from "./model/graph";
// --- the control surface (model/store.ts) -----------------------------------
export {
  addendum,
  dedendum,
  driveAngle,
  gearsScope,
  module,
  pressureAngle,
  rpm,
  running,
  showConstruction,
  showContact,
  studioGear,
  teethA,
  teethB,
} from "./model/store";

// --- widgets (pure readers over the instance above) --------------------------
export { App } from "./ui/App";
export { GearMesh, type SceneData } from "./ui/GearMesh";
export { ToothStudio } from "./ui/ToothStudio";
