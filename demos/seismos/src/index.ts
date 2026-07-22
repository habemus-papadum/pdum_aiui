/**
 * @habemus-papadum/demo-seismos — the earthquake catalog notebook as a
 * LIBRARY: store surface, graph accessor, widgets, and the pure
 * Gutenberg–Richter math, importable by any workspace sibling (the gallery
 * composes the ./page subpath; this barrel is for finer-grained reuse).
 *
 * Identity is scoped: every control, durable, and cell is qualified under
 * `seismosScope` ("seismos/mc", window.__seismos…), so this demo coexists in
 * one document with the other demos — the aiui composability model (aiui-viz
 * scope.ts; user guide, "Composing bigger apps"). The widgets and graph read
 * the ONE module-level instance (an app that exports its parts, not a
 * multi-instance slice factory — see demos/oscillator for that pattern).
 */

// --- pure model (playbook layer 1) -------------------------------------------
export {
  bValue,
  type CumPoint,
  cumulative,
  fitLine,
  type GrFit,
  type MagBin,
  mcMaxCurvature,
  totalCount,
} from "./gr";

// --- the cell graph (graph.ts) -----------------------------------------------
export { type GrStats, type SeismosGraph, seismosGraph } from "./graph";
export { type SeismicPalette, seismic } from "./palette";
export { MagHistogramClient } from "./stats-client";
// --- the durable roots + control surface (store.ts) --------------------------
export {
  type BorderPoint,
  DEFAULT_MC,
  EQ_X_MAX,
  EQ_Y_MAX,
  equalEarth,
  type LoadState,
  MC_MAX,
  MC_MIN,
  type SeismosStore,
  type Summary,
  seismosScope,
  store,
} from "./store";

// --- widgets (pure readers over the instance above) --------------------------
export { App } from "./ui/App";
export { Controls } from "./ui/Controls";
export { Dashboard } from "./ui/Dashboard";
export { Facets } from "./ui/Facets";
export { GutenbergRichter } from "./ui/GutenbergRichter";
export { MosaicView } from "./ui/MosaicView";
export { StatTiles } from "./ui/StatTiles";
