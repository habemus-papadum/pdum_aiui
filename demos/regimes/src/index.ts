/**
 * index.ts — the app's LIBRARY surface (the `.` export): what a sibling
 * package importing this app gets — the scope, the graph accessor, the root
 * component, the widgets, and the pure model each section demonstrates.
 * The mountable page lives behind `./page` on purpose: importing this barrel
 * must not drag in the page stylesheet or wiring side effects.
 */
export { divergence, invariantHistogram, LYAPUNOV, trajectoryPair } from "./model/chaos";
export { dieDistribution, entropyBits, pointwiseFloor, simulateDie } from "./model/dice";
export { type AppGraph, graph, reseed } from "./model/graph";
export {
  bestInFamily,
  decompose,
  ensemble,
  makeDataset,
  polyEval,
  polyfit,
  signalVariance,
  trueF,
} from "./model/regress";
export { lossCurve, spectralState } from "./model/spectral";
export { appScope } from "./model/store";
export { App } from "./ui/App";
export { ChaosPanel } from "./ui/ChaosPanel";
export { DecompPanel } from "./ui/DecompPanel";
export { DiePanel } from "./ui/DiePanel";
export { EnsemblePanel } from "./ui/EnsemblePanel";
export { SpectralPanel } from "./ui/SpectralPanel";
export { WorldPanel } from "./ui/WorldPanel";
