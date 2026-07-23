/**
 * index.ts — the app's LIBRARY surface (the `.` export): what a sibling
 * package importing this app gets. The starter exports its scope, graph, and
 * root component; as your real app grows, export its store surface, widgets,
 * and pure model functions here the same way (the in-repo reference demos —
 * morphogen, aztec, seismos, circle in pdum_aiui — model the shape).
 *
 * The mountable page lives behind the `./page` subpath on purpose: importing
 * THIS barrel should not drag in the page's stylesheet or wiring side effects.
 */
// The notation itself — pure, framework-free, and the part worth reusing.
export * from "./model/dna";
export * from "./model/fold";
export * from "./model/foldLayout";
export * from "./model/glyph";
// The app: control surface, cell graph, and the components that draw it.
export { type AppGraph, EXAMPLES, flipStrand, graph, loadExample } from "./model/graph";
export {
  appScope,
  foldSize,
  glyphSize,
  minHelix,
  minLoop,
  rotatePartner,
  sequence,
  showLetters,
} from "./model/store";
export { App } from "./ui/App";
export { Duplex } from "./ui/Duplex";
export { FoldFigure } from "./ui/FoldFigure";
export { Glyph, Strand } from "./ui/Glyph";
export { GlyphKey, PairDemo } from "./ui/GlyphKey";
