/**
 * Pencil Lab — the aesthetics rig for `@habemus-papadum/aiui-pencil`.
 *
 *   pnpm -C packages/aiui-pencil lab
 *   pnpm -C packages/aiui-pencil lab --host   # draw directly on an iPad
 *
 * Layer map, per the frontend playbook:
 *
 *   ../../src/*.ts        layer 1 — the pure stroke pipeline (the library itself)
 *   src/model/store.ts    durable roots + the control surface
 *   src/model/capture.ts  the pen recorder — imperative, non-reactive, 120Hz
 *   src/model/pad-renderer.ts  the canvas island — no signals in the hot loop
 *   src/model/graph.ts    the cell graph + the agent tools
 *   src/ui/               components
 */

import { PageBoundary } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import "./styles.css";
import "./model/graph"; // builds the cell graph + registers the agent tools
import { App } from "./ui/App";

render(
  () => (
    <PageBoundary name="Pencil Lab">
      <App />
    </PageBoundary>
  ),
  document.getElementById("root") as HTMLElement,
);
