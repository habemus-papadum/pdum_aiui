/**
 * RichTeX Lab — the rig for `RichTeX` (`@habemus-papadum/aiui-viz/site`):
 * an equation built from pieces, every piece styled, hovered, annotated and
 * reactive after KaTeX has drawn it — and, since the Mermaid spike, for
 * `Mermaid` (`@habemus-papadum/aiui-viz/site/mermaid`): a diagram whose
 * nodes and edges are the same kind of addressable pieces.
 *
 *   pnpm -C packages/aiui-viz lab
 *
 * Pages (one document, routed on the pathname):
 *   /fidelity    the proof — marked and plain renders, pixel-diffed and measured
 *   /training    an RL objective whose terms breathe with a (fake) training run
 *   /derivation  completing the square, step by step, every term evaluated live
 *   /fourier     a square wave's harmonics: hover a term, see its wave; click to mute
 *   /pipeline    a build pipeline as a flowchart: click a stage, drag the train node
 *   /anatomy     any Mermaid source, rendered: what became addressable, at what cost
 *
 * Layer map, per the frontend playbook:
 *   ../../src/site/rich-tex.tsx   the component under test (the library itself)
 *   ../../src/site/mermaid.tsx    the Mermaid component (same layer)
 *   src/model/{training,quadratic,fourier,pipeline}.ts   layer 1 — pure, unit-tested
 *   src/model/store.ts            durable roots + the control surface
 *   src/model/graph.ts            the cell graph, the bridges, the agent tools
 *   src/ui/                       components
 */
import "@habemus-papadum/aiui-design/site.css";
import "./styles.css";
import "./mermaid.css";
import "./model/graph"; // builds the cell graph + registers the agent tools
import { PageBoundary } from "@habemus-papadum/aiui-viz";
import { configureMermaid } from "@habemus-papadum/aiui-viz/site/mermaid";
import { render } from "@solidjs/web";
import { App } from "./ui/App";
import { LAB_MERMAID } from "./ui/mermaid-theme";

// The design system's palette and fonts, once, for every diagram.
configureMermaid(LAB_MERMAID);

render(
  () => (
    <PageBoundary name="RichTeX Lab">
      <App />
    </PageBoundary>
  ),
  document.getElementById("root") as HTMLElement,
);
