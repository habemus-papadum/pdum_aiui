/**
 * @habemus-papadum/aiui-viz — reactive scientific-visualization utilities for
 * agent-written frontends, extracted from the morphogen demo. The methodology
 * these embody is documented at docs/guide/frontend-for-agents (and worked
 * through in the demo's PRINCIPLES.md).
 *
 * The core surface is framework code — async cells, worker streaming, the
 * durable HMR registry, and the agent tool surface. The Observable Plot bridge
 * lives behind the `./plot` subpath so @observablehq/plot stays an optional
 * peer that core consumers never pay for.
 */

export type { AgentTool, AgentToolkit, AgentToolkitHandle } from "./agent-tools";
// agent-tools.ts — the WebMCP-flavored tool surface an agent drives.
export { agentToolkit } from "./agent-tools";
export type { Cell, CellCompute, CellContext, CellOptions, CellState } from "./cell";
// cell.ts — Observable-style async dataflow cells for SolidJS 2.0.
export {
  cell,
  cellByName,
  cellGraph,
  cellRegistry,
  settledOnly,
} from "./cell";
// cell-view.tsx — the notebook-feel wrapper (spinner, error+retry, keep-latest).
export { CellView, ProgressStripe, Spinner } from "./cell-view";

export type {
  ActionSpec,
  ControlBox,
  ControlMeta,
  ControlSpec,
  ControlSurfaceEntry,
  RegisteredAction,
} from "./control";
// control.ts — the control surface: controls (writable frontier) + actions (verbs).
export { action, actionByName, control, controlByName, controlSurface } from "./control";
// control-widgets.tsx — the earned control-bound widgets (slider, toggle).
export { ControlSlider, ControlToggle } from "./control-widgets";
export { Dropdown } from "./dropdown";
export type { SignalBox } from "./durable";
// durable.ts — the durable/disposable registry that makes HMR safe.
export { disposeDurable, durable, durableSignal } from "./durable";
export type { DependencyEdge, DependencyRead } from "./graph-trace";
// graph-trace.ts — runtime dependency edges (controls→cells, cells→cells).
export { dependencyEdges } from "./graph-trace";
export type { HotContext } from "./hot-graph";
// hot-graph.ts — the durable box + dispose-and-swap + self-accept, in one call.
export { hotCellGraph } from "./hot-graph";
export { type LiveSignal, liveSignal } from "./live-signal";
export type { Scope } from "./scope";
// scope.ts — instance identity for composable slices (qualified names).
export { SCOPE_SEPARATOR, scope } from "./scope";
// standard-tools.ts — the app-independent `locate` tool and `cells` reporter.
export { registerStandardTools } from "./standard-tools";
export type { WorkerCancel, WorkerReply, WorkerRequest, WorkerRun } from "./worker-stream";
// worker-stream.ts — cancellable request/stream protocol for Web Workers.
export { fromWorker, workerStream } from "./worker-stream";
