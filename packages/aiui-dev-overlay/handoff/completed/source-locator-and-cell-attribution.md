# Handoff: source-location stamping + element→cell attribution

> **STATUS (2026-07-05): implemented** — `aiuiDevOverlay({ locator })` in
> `packages/aiui-dev-overlay/src/{vite,source-locator}.ts`; demo switched over.


For the overlay team, from the morphogen/demo session (2026-07-05). A working
prototype of everything below lives in `packages/aiui-demo` and is verified
live; this doc gives you the code, the paid-for technical findings, and the
design decisions that are deliberately left to you. The overlay already ships
a Vite plugin (`src/vite.ts`) — this is a natural second concern for it (or a
sibling plugin it exports), and it composes with what the plugin already
injects: `window.__AIUI__.sourceRoot` is the missing piece that turns these
relative stamps into absolute paths.

## What it does (the contract — this is the part to preserve)

Two DOM attributes plus one registry, all dev-server-only:

1. **`data-source-loc="src/ui/Controls.tsx:81:9"`** on every *host* JSX
   element — where the element was authored. Relative to the app root;
   `window.__AIUI__.sourceRoot + "/" + loc` is absolute and clickable.
2. **`data-cell="catalog"`** on elements that render a dataflow node's value —
   *which computation produced what you're looking at*. Stamped automatically
   by `CellView` (the demo's async-value wrapper) and manually (one attribute)
   by components that render cell values without a wrapper.
3. **A cell registry**: `window.__morpho.report().cells` →
   `[{ name: "analysis", loc: "src/model/graph.ts:103", state: "ready", settled: true }, …]`
   — names match the `data-cell` stamps; `loc` is the cell's *definition* site.

Verified end-to-end: the demo's `locate` agent tool
(`__morpho.call("locate", { selector })`) returns, per element, its tag, text,
`source` (authoring site) and `cell` (nearest attribution boundary) — an agent
goes from "this table cell on screen" to both the JSX that rendered it and the
dataflow node that computed it in one call.

The contract is deliberately **framework-neutral even though the mechanism is
not**: a React or vanilla consumer can honor the same attributes/registry by
other means. Specify the contract in overlay docs; treat the mechanism below
as the Solid-flavored reference implementation.

## The code

Reference implementation (all in `packages/aiui-demo`, current on `main`):

- `babel-source-locator.mjs` — the babel plugin (both halves) **and** the
  standalone Vite plugin wrapper `sourceLocatorVite({ root })`. ~140 lines,
  dependency-free except `@babel/core`. This file is the thing to lift.
- `src/lib/cell.ts` — `CellOptions.name/loc`, the `cellRegistry()` /
  `cellByName()` registry, and owner-scoped deregistration (search "registry").
- `src/lib/cell-view.tsx` — the one-line `data-cell={props.of.cellName}` stamp.
- `src/model/graph.ts` — the `cells` reporter and the `locate` tool.

How the cell half achieves **zero affordance** in user code: the babel plugin
visits `cell(deps, compute)` call sites and injects a third argument
`{ name, loc }`, inferring the name from where the value lands
(`const catalog = cell(…)` → `"catalog"`; object properties and assignments
also handled). User scientific code never mentions attribution. Cells register
themselves at creation and deregister via `onCleanup` on their reactive owner —
so a graph hot-swap replaces the registry population atomically and HMR
correctness costs nothing.

## Paid-for findings (each one cost a debugging loop — do not rediscover)

1. **Stamp JSX from `Program.enter` with an explicit `path.traverse`, never
   from a top-level `JSXOpeningElement` visitor.** babel-preset-solid's
   compiler visits each outermost `JSXElement`, compiles the whole subtree
   internally, and replaces it — the shared traversal never descends into JSX
   children, so another plugin's per-node JSX visitors silently never fire.
   (`@locator/babel-jsx` structures itself the same way, for the same reason.)
   Corollary for verifying any babel plugin: a plugin can be *instantiated*
   and its `Program` visitor run while its JSX visitors never do — instrument
   the traversal, not the instantiation.
2. **Ship a standalone Vite plugin (`enforce: "pre"`), not a
   vite-plugin-solid `babel` option.** Two reasons: vite-plugin-solid only
   transforms `.jsx/.tsx`, so `cell()` calls in plain `.ts` model files are
   never seen by its babel pass (this bit us — the whole model layer went
   uninstrumented); and the standalone pass decouples the feature from Solid
   entirely. The wrapper in the reference file does this, with a cheap content
   sniff (`/<[A-Za-z]|\bcell\s*\(/`) so files with nothing to stamp skip the
   parse.
3. **Parser options differ by extension**: enable the `jsx` parser plugin only
   for `*.jsx/*.tsx`. In plain `.ts`, jsx makes `<T>expr` type assertions
   ambiguous.
4. **Don't put the cell's identity on a property named `name`.** A cell is
   callable; `Function.name` is read-only, the assignment silently fails (or
   throws), and reads leak the internal closure's inferred name — every stamp
   said `"read"` until this was found. The reference uses `cellName` at
   runtime (`name` stays fine as an *options* key).
5. **LocatorJS status on Solid 2.0** (why this exists at all):
   `@locator/babel-jsx` works but emits `file::<element-index>` only (line
   numbers live in a side-table consumed by its runtime);
   `@locator/runtime` is precompiled Solid 1.x (`import … from "solid-js/web"`,
   renamed in 2.0) and crashes vite's dep optimizer; `solid-devtools` pins
   solid-js `^1.9`. Hence: own plugin, real `file:line:col`, no dependency.

## Decisions that are yours (with our leanings, not verdicts)

- **Opt-in shape.** The user's requirement: element→cell attribution must be
  a no-op / zero cost when unused, and probably explicitly enabled at plugin
  registration. Natural shape: `aiuiDevOverlay({ locator: true })` for the JSX
  half, and something like `locator: { cellFactories: ["cell"] }` to enable
  the call-site half with configurable factory names (the syntactic heuristic
  currently matches a callee literally named `cell`; other codebases will
  have other factories, or none). Both halves are already structurally
  zero-cost when off: `apply: "serve"`, attributes only, no runtime library.
- **Where the registry surfaces.** The prototype exposes cells through the
  page's own tool handle (`report().cells`). If the overlay standardizes a
  per-page tools/report surface (see the sibling handoff,
  `frontend-tool-registry.md`), the cell table should ride that; a dedicated
  `window.__aiuiCells` is the fallback. The registry itself must live in the
  *app's* code (it knows its cells) — the overlay only standardizes where an
  agent looks for it.
- **Non-Solid / non-cell consumers.** The JSX half generalizes to any JSX
  framework as-is (it runs before any framework compiler that replaces JSX;
  for React/automatic-runtime it degrades to plain attributes untouched).
  The cell half is a contract other stacks can implement manually (an
  attribute + a registry entry). Document it that way.
- **Granularity limits worth documenting** (so nobody oversells it): naming is
  syntactic (aliased factories invisible); attribution is boundary-based
  (`data-cell` marks the wrapper whose subtree renders the value — not every
  leaf text node), and values read *outside* any stamped boundary attribute to
  nothing. The precise future is reactive-graph introspection (per-element
  effects know their dependency sets), which needs Solid dev internals —
  a good later project, not needed for the workflow today.
- **Perf.** The extra babel parse is dev-only and sniff-gated; unmeasurable at
  demo scale (~30 files). If it matters at real-app scale, the escape hatch is
  folding the same babel plugin into the consumer's existing babel pass for
  `.tsx` and keeping the standalone pass only for `.ts` — the plugin function
  is shared either way.
