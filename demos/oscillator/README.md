# @habemus-papadum/aiui-oscillator

A damped-oscillator **slice**: a reusable control-surface + cell factory, and the repo's worked
example of the aiui composability model. Internal and never published (`"private": true`) — it
exists so the pattern has a living reference:

- **`oscillatorStore(scope)`** declares one instance's control surface (`freq` / `damping` /
  `amp` controls, a `kick` action, internal `phase` state) under an explicit
  [`Scope`](../aiui-viz/src/scope.ts). Two instances from this one call site get distinct
  qualified identity (`left/freq`, `right/freq`) and distinct durable state — the
  double-instantiation problem scopes exist to fix.
- **`oscillatorCells(scope, store)`** builds the derived cells (`params`, `trace`) over an
  instance, inside whatever `hotCellGraph` the consuming app owns. A slice never owns the graph
  ritual — it contributes cells to the app's one graph.
- **Identity is library-grade**: this package runs the aiui compiler in its own toolchain
  (`vitest.config.ts` for tests, `vite.config.ts` for the dist build) with a `locPrefix`, so the
  slice's names, descriptions, and package-qualified locs
  (`@habemus-papadum/aiui-oscillator/src/slice.ts:NN`) are baked wherever it is consumed. In-repo
  consumers import the source and their own compiler injects dotdot-relative locs instead.

The consuming demo is [`demos/twins`](../../demos/twins) (two instances side by side, composed
into a Lissajous figure); the methodology write-up is the user guide's "Composing bigger apps"
section.
