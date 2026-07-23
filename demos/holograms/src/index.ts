/**
 * index.ts — the LIBRARY surface (the `.` export): the scope, the graph, the
 * root component, and the pure bench pipeline (record → develop → playback
 * over aiui-optics) for siblings that want the physics without the page.
 * Page wiring (styles, graph side effects) stays behind ./page.
 */
export {
  beamSplit,
  cutFilm,
  developBench,
  exposeBench,
  FILM,
  finestFringe,
  ghostPredictions,
  LAMBDA_BAND,
  meanObjectPath,
  playbackExitField,
  referenceArm,
  referenceBeam,
} from "./model/bench";
export { type AppGraph, graph } from "./model/graph";
export { appScope, type ScenePoint } from "./model/store";
export {
  apparentDirection,
  exposePatch,
  retinaView2D,
  type ScenePoint3D,
  WINDOW_SCENE,
} from "./model/window2d";
export { App } from "./ui/App";
