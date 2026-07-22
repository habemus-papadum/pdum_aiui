/**
 * @habemus-papadum/demo-aztec — random domino tilings of the Aztec diamond as
 * a LIBRARY: store surface, graph accessor, widgets, and the pure shuffle /
 * permanent math, importable by any workspace sibling (the gallery composes
 * the ./page subpath; this barrel is for finer-grained reuse).
 *
 * Identity is scoped: every control, durable, cell, and action is qualified
 * under `aztecScope` ("aztec/seed", window.__aztec…), so this demo coexists in
 * one document with the other demos — the aiui composability model (aiui-viz
 * scope.ts; user guide, "Composing bigger apps"). The widgets and graph read
 * the ONE module-level instance (an app that exports its parts, not a
 * multi-instance slice factory — see demos/oscillator for that pattern).
 */

// --- the cell graph (graph.ts) -----------------------------------------------
export { type AztecGraph, aztecGraph, type FrozenPoint } from "./graph";
// --- pure model (playbook layer 1) -------------------------------------------
export { COLOR, LEGEND } from "./palette";
export { biadjacency, ryserPermanent, tilingCount } from "./permanent";
export { type DrawOptions, draw } from "./render";
export { mulberry32, type Rng } from "./rng";
export {
  create,
  destruct,
  dominoCells,
  frozenFraction,
  generate,
  inDiamond,
  initTiling,
  rasterize,
  slideGrow,
  step,
  type Tiling,
  tilingProblem,
} from "./shuffle";
// --- the durable roots + control surface (store.ts) --------------------------
export {
  aztecCanvas,
  aztecScope,
  aztecSurface,
  CANVAS_PX,
  ctx2d,
  type FrameRing,
  fps,
  frameIndex,
  frames,
  MAX_FRAMES,
  MAX_N,
  type Player,
  player,
  playing,
  regrow,
  runId,
  seed,
  showCircle,
  shuffleWorker,
  targetN,
} from "./store";
export type {
  CellLabel,
  Domino,
  DominoType,
  PermanentCheck,
  PermanentResult,
  ShuffleFrame,
  ShuffleRequest,
} from "./types";

// --- widgets (pure readers over the instance above) --------------------------
export { App } from "./ui/App";
export { AztecCanvas } from "./ui/AztecCanvas";
export { Controls } from "./ui/Controls";
export { FrozenChart } from "./ui/FrozenChart";
export { Legend } from "./ui/Legend";
export { Permanents } from "./ui/Permanents";
export { Tiles } from "./ui/Tiles";
