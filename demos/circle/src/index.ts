/**
 * @habemus-papadum/demo-circle — the circle-drawing meter as a LIBRARY: store
 * surface, graph accessor, widgets, and the pure fitting math, importable by
 * any workspace sibling (the gallery composes the ./page subpath; this barrel
 * is for finer-grained reuse).
 *
 * Identity is scoped: every control, durable, cell, and action is qualified
 * under `circleScope` ("circle/fadeSeconds", window.__circle…), so this demo
 * coexists in one document with the other demos — the aiui composability model
 * (aiui-viz scope.ts; user guide, "Composing bigger apps"). The widgets and
 * graph read the ONE module-level instance (an app that exports its parts, not
 * a multi-instance slice factory — see demos/oscillator for that pattern).
 */

// --- pure model (playbook layer 1) -------------------------------------------
export { CenterGhost, TRAIL_MS } from "./model/center-ghost";
export {
  type CircleFit,
  type CircleStats,
  centroid,
  type EllipseFit,
  fitCircle,
  fitEllipseMoments,
  sampleEllipse,
  summarize,
  sweepDegrees,
} from "./model/circle";
// --- the cell graph (model/graph.ts) -----------------------------------------
export { type AppGraph, buildGraph, graph } from "./model/graph";
// --- the durable roots + control surface (model/store.ts) --------------------
export {
  brushSize,
  centerGhost,
  circleScope,
  currentParams,
  fadeSeconds,
  frozenPoints,
  guideMode,
  HISTORY_LEN,
  ink,
  paper,
  recordTurn,
  resetTurn,
  scoreHistory,
  type TurnPhase,
  turnCount,
  turnPhase,
  turnPoints,
} from "./model/store";

// --- widgets (pure readers over the instance above) --------------------------
export { App } from "./ui/App";
export { CenterGhostLayer } from "./ui/CenterGhostLayer";
export { Dock } from "./ui/Dock";
export { FitOverlay } from "./ui/FitOverlay";
export { GuideModeToggle } from "./ui/GuideModeToggle";
export { MathSection } from "./ui/MathSection";
export { Sparkline } from "./ui/Sparkline";
export { StatsPanel } from "./ui/StatsPanel";
