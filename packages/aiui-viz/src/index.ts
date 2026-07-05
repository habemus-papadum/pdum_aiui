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

// durable.ts — the durable/disposable registry that makes HMR safe.
export { disposeDurable, durable } from "./durable";
export type { WorkerCancel, WorkerReply, WorkerRequest, WorkerRun } from "./worker-stream";
// worker-stream.ts — cancellable request/stream protocol for Web Workers.
export { fromWorker, workerStream } from "./worker-stream";
