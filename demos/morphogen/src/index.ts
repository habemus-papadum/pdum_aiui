/**
 * @habemus-papadum/demo-morphogen — the Gray-Scott reaction–diffusion lab as a
 * LIBRARY: its store surface, cell graph accessor, widgets, and pure model,
 * importable by any workspace sibling (the gallery composes the ./page subpath;
 * this barrel is for finer-grained reuse).
 *
 * Identity is scoped: every control, durable, cell, and action here is
 * qualified under `morphogenScope` ("morphogen/paramF", window.__morphogen…),
 * so this demo coexists in one document with the other demos — the aiui
 * composability model (aiui-viz scope.ts; user guide, "Composing bigger
 * apps"). Note the widgets and graph read the ONE module-level instance below
 * (this package is an app that exports its parts, not a multi-instance slice
 * factory like demos/oscillator — see that package for the factory pattern).
 */

export {
  areaHistogram,
  autocorrelationAtLag,
  dominantWavelength,
  labelComponents,
  type SpotCensus,
} from "./analysis/core";

// --- the cell graph (model/graph.ts) ----------------------------------------
export { type MorphoGraph, morphoGraph } from "./model/graph";

// --- pure model (playbook layer 1) ------------------------------------------
export { REGIME_CATALOG, type Regime } from "./model/regime-data";
// --- the durable roots + control surface (model/store.ts) -------------------
export {
  analysisWorker,
  autoAnalyze,
  brushRadius,
  DIFFUSION,
  failNextFetch,
  HISTORY_LIMIT,
  type HistoryRing,
  history,
  morphogenScope,
  paramF,
  paramK,
  quality,
  SIM_SIZE,
  type SimHandle,
  sim,
  simCanvas,
  snapshot,
  speed,
  threshold,
} from "./model/store";
export { computeFieldStats, type FieldStats } from "./sim/stats";

// --- widgets (pure readers over the instance above) --------------------------
export { AnalysisPanel } from "./ui/AnalysisPanel";
export { App } from "./ui/App";
export { Controls } from "./ui/Controls";
export { RegimeAtlas } from "./ui/RegimeAtlas";
export { RegimeTable } from "./ui/RegimeTable";
export { SimCanvas } from "./ui/SimCanvas";
export { StatsTiles } from "./ui/StatsTiles";
export { TimeSeries } from "./ui/TimeSeries";
