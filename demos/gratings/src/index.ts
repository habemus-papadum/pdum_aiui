/**
 * index.ts — the LIBRARY surface (the `.` export): the scope, the graph, the
 * root component, and the pure bench math (the design formulas a sibling
 * might want without mounting the page). Page wiring (styles, graph side
 * effects) stays behind ./page on purpose.
 */
export {
  effectiveSlits,
  FILM,
  gratingOrders,
  LAMBDA_BAND,
  lensImage,
  resolvingPower,
  SPECTRO_LAMBDAS,
  zoneFocalAt,
  zoneLocalPitch,
} from "./model/bench";
export { type AppGraph, graph } from "./model/graph";
export { appScope } from "./model/store";
export { App } from "./ui/App";
