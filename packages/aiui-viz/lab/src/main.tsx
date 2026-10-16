/**
 * RichTeX Lab — the rig for `RichTeX` (`@habemus-papadum/aiui-viz/site`):
 * an equation built from pieces, every piece styled, hovered, annotated and
 * reactive after KaTeX has drawn it.
 *
 *   pnpm -C packages/aiui-viz lab
 *
 * Pages (one document, routed on the pathname):
 *   /fidelity    the proof — marked and plain renders, pixel-diffed and measured
 *   /training    an RL objective whose terms breathe with a (fake) training run
 *   /derivation  completing the square, step by step, every term evaluated live
 *   /fourier     a square wave's harmonics: hover a term, see its wave; click to mute
 *
 * Layer map, per the frontend playbook:
 *   ../../src/site/rich-tex.tsx   the component under test (the library itself)
 *   src/model/{training,quadratic,fourier}.ts   layer 1 — pure, unit-tested
 *   src/model/store.ts            durable roots + the control surface
 *   src/model/graph.ts            the cell graph, the bridge, the agent tools
 *   src/ui/                       components
 */
import "@habemus-papadum/aiui-design/site.css";
import "./styles.css";
import "./model/graph"; // builds the cell graph + registers the agent tools
import { PageBoundary } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import { App } from "./ui/App";

render(
  () => (
    <PageBoundary name="RichTeX Lab">
      <App />
    </PageBoundary>
  ),
  document.getElementById("root") as HTMLElement,
);
