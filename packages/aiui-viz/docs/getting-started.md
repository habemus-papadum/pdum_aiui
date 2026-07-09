# Getting Started with @habemus-papadum/aiui-viz

> This page lives at `packages/aiui-viz/docs/getting-started.md`. It's picked up automatically by the
> docs site as a guide under this package — edit or delete it, and add more `*.md` files here for
> additional per-package guides. The package overview comes from the `README.md`; the API
> reference is generated from `src/index.ts`.

`@habemus-papadum/aiui-viz` gives an agent-written SolidJS 2.0 frontend the pieces it needs to treat
every asynchronous value as a first-class, cancellable, observable **cell**. The two most common
starting points are a cell over a `fetch` (see the [README](../README.md)) and a cell over a **Web
Worker**, shown here.

## Install

```sh
npm install @habemus-papadum/aiui-viz solid-js @solidjs/web
```

## A cell driven by a worker

The worker protocol is a small request/stream contract: the cell posts `run` (and `cancel` on
supersession), the worker replies with `partial`, `progress`, `done`, or `error`. `fromWorker` turns
a worker into a compute function a cell consumes directly, so partials stream into the UI, progress
drives the progress stripe, and changing the input aborts the in-flight run — the worker really
receives the `cancel` and stops.

```tsx
import { createSignal } from "solid-js";
import { cell, CellView, cellGraph, fromWorker } from "@habemus-papadum/aiui-viz";

interface Report {
  histogram: number[];
  peak: number;
}

// A durable worker instance (create once; adopt across hot edits with `durable`).
const worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });

const [field, setField] = createSignal<Float32Array>();

const { graph } = cellGraph(() => {
  // Point a cell straight at the worker. `stream: "commit"` (the default) commits
  // each partial to the graph; use "latest" when downstream work is expensive.
  const analysis = cell(field, fromWorker<Float32Array, Report>(worker));
  return { analysis };
});

function AnalysisPanel() {
  return (
    <CellView of={graph.analysis} label="analyzing">
      {(report) => <p>peak = {report().peak}</p>}
    </CellView>
  );
}
```

The worker itself only needs to speak the protocol; the message types are exported so it stays typed:

```ts
// analysis.worker.ts
import type { WorkerReply, WorkerRequest } from "@habemus-papadum/aiui-viz";

self.onmessage = (e: MessageEvent<WorkerRequest<Float32Array>>) => {
  const msg = e.data;
  if (msg.type !== "run") return; // handle "cancel" by aborting your loop
  // ...compute, posting { id, type: "progress" | "partial" | "done" | "error" } as WorkerReply<Report>
};
```

For the full choreography (macrotask yields so `cancel` is observed, streaming the cheap result
early, keeping the math pure and headlessly testable), read the demo's
[`PRINCIPLES.md`](../../../demos/gallery/PRINCIPLES.md) §4 and its `analysis/` worker.
