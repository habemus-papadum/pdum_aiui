/**
 * @habemus-papadum/demo-gear-talk — the reference deck for the aiui slides
 * framework, as a LIBRARY: the slide list, the deck model, the talk's control
 * surface and cell graph, and the SVG figure vocabulary, importable by any
 * workspace sibling (the gallery composes ./page; this barrel is for
 * finer-grained reuse).
 *
 * Identity is scoped under `talkScope` ("gear-talk/…"), so the talk coexists
 * in one document with every other demo — including demos/gears, whose PURE
 * geometry it borrows (never its store: separate scopes, separate durables).
 */

export { deck, SLIDES } from "./deck";
export { graph, MODULE, type TalkGraph } from "./model/graph";
export {
  addendum,
  dedendum,
  pressureAngle,
  rpm,
  running,
  talkScope,
  teethA,
  teethB,
} from "./model/store";
export { AnatomySvg, InvoluteSvg, MeshSvg } from "./ui/figures";
export { useSpin } from "./ui/use-spin";
