# @habemus-papadum/aiui-viz

Reactive scientific-visualization utilities for **agent-written frontends** — the reusable core
extracted from the morphogen demo. Built for SolidJS 2.0 (beta) and its async-first graph: every
asynchronous value is a *cell*, long work streams with progress and real cancellation, and the split
between durable state and disposable logic is made explicit so hot-module reloading actually works
during a tight agent iteration loop.

This is the library layer of the repo's **frontend-for-agents** methodology. The long-form write-up
lives in the three-level guide at [`docs/guide/frontend-for-agents`](../../docs/guide/); the demo's
[`PRINCIPLES.md`](../aiui-demo/PRINCIPLES.md) and the [`aiui-demo`](../aiui-demo) app itself are the
worked example that every utility here was paid for building.

## Plumbing and porcelain

The library has two layers (one package for now; the seam is deliberate):

- **Plumbing** — the dataflow semantics: `cell`, the worker protocol, `durable`, the agent
  toolkit. Framework-adjacent, opinion-light, everything else builds on it.
- **Porcelain** — the notebook-page conveniences built *on* the plumbing: the Plot bridge
  (`/plot`), the page chrome + math + theming (`/site`). Each porcelain surface lives on its own
  subpath so its heavyweight dependency (`@observablehq/plot`, `katex`) stays an **optional
  peer** that plumbing consumers never pay for. Porcelain grows by extraction: a pattern proves
  itself in a reference notebook first, then moves here (the repo's
  [style guide](../../docs/guide/frontend-style-guide.md) tracks which patterns are where).

## What's in it

| Export | What it is |
| ------ | ---------- |
| `cell`, `cellGraph`, `cellRegistry`, `cellByName`, `settledOnly` | Observable-style async dataflow cells: a six-state machine (`unresolved · pending · streaming · refreshing · ready · errored`), an `AbortSignal` per run, progress, a cached last-good value that survives errors, and a retry affordance. Solid 2.0 does supersession/holds/transactional commits; the cell adds what UI and cancellation need. |
| `CellView`, `Spinner`, `ProgressStripe` | The notebook feel in one wrapper: spinner + progress before the first value, an error box with retry, and keep-the-last-render (dimmed, progress stripe) while a new run streams or refreshes. |
| `workerStream`, `fromWorker` | A dependency-free, cancellable request/stream protocol that turns a Web Worker into an async generator a cell consumes directly — partials stream in, progress drives `ctx.progress`, and aborting posts a `cancel` so the worker actually stops. |
| `durable`, `disposeDurable` | A keyed, idempotent `window` registry for resources that must outlive a module reload (a WebGL context, a worker, accumulated history, the user's parameters). `durable(key, create)` creates once and *adopts* forever after — the discipline HMR needs. |
| `agentToolkit` | A WebMCP-flavored tool surface installed at `window.__<ns>`: named, described, loosely-schema'd operations an agent discovers and calls, plus pluggable `report()` sections for one bounded, JSON-serializable snapshot of the app. When the aiui dev overlay is present it forwards the surface (real tools + a synthetic `report`) to the channel, so the tools become MCP tools (`page_tools_list`/`page_tools_call`) and calls route back to the live page — best-effort and dependency-free. |
| `@habemus-papadum/aiui-viz/plot` → `PlotFigure`, `PLOT_STYLE` | The Observable Plot bridge (reactive options in, a figure out) behind one seam. Kept on a subpath so `@observablehq/plot` stays an **optional** peer that core consumers never import. |
| `@habemus-papadum/aiui-viz/site` → `SiteHeader`, `TocRail`, `TeX`, `colorMode` | Page chrome for the paper-like notebook anatomy: the sticky header with descriptor tabs, the "On this page" rail, KaTeX math with the `data-tex` attribution stamp, and the reactive `prefers-color-scheme` signal apps key their palettes on. `katex` is an optional peer only `/site` consumers need. Styling is the consumer's (`.site-*`, `.toc-*`, `.math-*`) — same CSS seam as `CellView`. |

## Install

```sh
npm install @habemus-papadum/aiui-viz solid-js @solidjs/web
# only if you use the /plot subpath:
npm install @observablehq/plot
```

`solid-js` and `@solidjs/web` are peers (`>=2.0.0-beta.0 <2.0.0-experimental.0`); `@observablehq/plot`
(`^0.6`) is an optional peer, needed only for `@habemus-papadum/aiui-viz/plot`.

## A minimal cell + CellView

```tsx
import { createSignal } from "solid-js";
import { cell, CellView, cellGraph } from "@habemus-papadum/aiui-viz";

// A durable input; the graph built over it is disposable.
const [query, setQuery] = createSignal("gray-scott");

const { graph } = cellGraph(() => {
  // An async cell. A superseded run (query changes) aborts via ctx.signal,
  // and the previous value stays on screen, dimmed, until the new one lands.
  const results = cell(query, async (q, ctx) => {
    const res = await fetch(`/search?q=${encodeURIComponent(q)}`, { signal: ctx.signal });
    return (await res.json()) as string[];
  });
  return { results };
});

function Results() {
  return (
    <CellView of={graph.results} label="searching">
      {(value) => <ul>{value().map((r) => <li>{r}</li>)}</ul>}
    </CellView>
  );
}
```

`CellView` emits stable class names (`cell-body`, `cell-body-loading`, `cell-pending`, `cell-error`,
`progress-stripe`, `progress-stripe-fill`, and `btn`/`btn-outline` on the retry button) — style them
in your app. The demo's [`styles.css`](../aiui-demo/src/styles.css) is a worked dark-surface example.

## See it in use

The [`aiui-demo`](../aiui-demo) package is a Gray-Scott reaction-diffusion laboratory built entirely
on these utilities — a WebGL sim, a cancellable worker analysis pipeline, streaming downloads, Plot
charts, and a `window.__morpho` agent tool surface. Read [`PRINCIPLES.md`](../aiui-demo/PRINCIPLES.md)
for the methodology and the per-principle bugs each utility was designed against.
