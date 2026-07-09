# Frontend: hard-won details

The level-3 ledger: technical findings underneath
[Frontend for agents](./frontend-for-agents) and
[Design choices](./frontend-design-choices), each paid for with a real debugging loop while
building the reference notebooks. Some are transient (pinned to beta versions — noted); all are
worth keeping so nobody pays twice. Format: **symptom → cause → rule.**

Versions these were established against: `solid-js@2.0.0-beta.15`, `@solidjs/web@2.0.0-beta.15`,
`vite-plugin-solid@3.0.0-next.5`, Vite 6, `@babel/core` 7.29.

## SolidJS 2.0 (beta) semantics

- **Owned-scope writes throw in dev.** Setting a signal from inside a memo compute, a component
  body — or the *synchronous prologue of an async generator consumed by a memo* — raises
  `REACTIVE_WRITE_IN_OWNED_SCOPE`. Internal bookkeeping signals (a cell's
  progress/settled/partial) opt in with `createSignal(v, { ownedWrite: true })`; otherwise defer
  the write (`queueMicrotask`) or move it to an event handler. The solid-cells probe notes
  predate this enforcement.
- **`createEffect(source, handler)`: the handler is untracked — for reads too.** Writes belong in
  the handler (that's the design), but reading a signal *inside the handler* warns
  `STRICT_READ_UNTRACKED` (at 60 Hz, spectacularly) and can miss updates. Consume the value the
  source computed: `createEffect(() => frames.at(i.get()), (frame) => draw(frame))`, not
  `createEffect(i.get, () => draw(frames.at(i.get())))`.
- **Same-tick reads after writes lie.** Writes are batched: `x.set(v); x.get()` in one
  synchronous tick can return the pre-write value. Two places this bites: an agent tool that
  `set`s then returns a `get` (return the value you computed instead), and driving the app via
  `evaluate_script` — a synchronous `report()` right after a tool call reads stale; await a task
  boundary (`setTimeout 0`) first. Cross-task reads are always correct.
- **Gone from 1.x:** `onMount` (use ref callbacks — they run when the element exists),
  `classList` (compute class strings). `render` and the `JSX` type moved to `@solidjs/web`
  (`jsxImportSource` likewise). `<Show>`'s non-keyed function child receives an **accessor**;
  keyed receives the value.
- **Errored memos read as `undefined` and drop their previous value**; without an error boundary
  the failure is near-silent (`isPending` stays true, error dumped globally). This is why cells
  cache their own last value and wrap state derivation in `createErrorBoundary` — and why
  `refetch()` must route through the boundary's `reset()` to re-run a failed compute.
- **A callable's identity can't live on `.name`.** Cells are functions; `Function.name` is
  read-only, the assignment fails, and reads leak the internal closure's inferred name (every
  attribution stamp briefly read `"read"`). Use a differently-named property (`cellName`).

## Theming under prefers-color-scheme

- **Figure colors and panel-chart colors are different species.** A color painting a
  self-contained dark canvas (and the legend chips that key it) must be a *constant* across
  modes; the "same" color used as a chart mark on a panel surface must be *per-mode*. Identical
  hex in dark mode, they diverge in light. Validate a figure palette against BOTH the figure
  surface and the opposite-mode panel where its legend chips appear.
- **A module-level `mode()` signal makes the system theme fully reactive** — chart-option memos
  that read it re-render on a live OS theme flip, no reload. Put the `matchMedia` listener
  inside `durable()` so HMR re-evaluation doesn't stack listeners.
- **`as const` palette objects over-narrow.** Literal-union types from `as const` fail
  `Record<Mode, Palette>` indexed access ("'#2f6fce' not assignable to '#4a86dd'"); type
  palettes with an explicit interface instead.

## Mosaic / DuckDB-WASM (versions: @uwdata/vgplot 0.28.1, @duckdb/duckdb-wasm 1.33.1-dev45.0)

Found building the seismos notebook (full detail: `demos/gallery/src/pages/seismos/NOTES.md`):

- **A custom MosaicClient defaults to being served from the pre-aggregation index**, which
  applies interval clauses but silently DROPS point clauses — a categorical cross-filter that
  looks wired but does nothing. Override `get filterStable() { return false }` on clients that
  must see every clause.
- **A 2-D region clause needs `scales` metadata to propagate** through a Selection; when
  driving filters programmatically (agent tools), two 1-D `clauseInterval`s (lon + lat) behave
  where one 2-D clause won't.
- **`intervalXY` on a `raster` mark resolves the brush field to NULL** — pass `xfield`/`yfield`
  explicitly.
- **A mosaic-inputs Menu bound to a Selection is write-only** (no back-sync); reset the
  `<select>` yourself when its clause clears elsewhere.
- Pin `@duckdb/duckdb-wasm` to the exact version `@uwdata/mosaic-core` depends on, so one
  deduped copy exists; build DuckDB from locally `?url`-imported wasm/worker assets (no CDN) —
  it survives a hosting prefix and works offline.

## Biome (lint) specifics

- `useAnchorContent` rejects icon-only anchors even with `aria-label` + an `aria-hidden` SVG —
  it wants real content; add a visually-hidden `<span class="sr-only">`.
- Solid's `innerHTML` prop is NOT covered by `noDangerouslySetInnerHtml` (a React-only rule) —
  and a suppression comment for it errors as *unused*. KaTeX-via-innerHTML needs no suppression.
- `noShadowRestrictedNames` forbids a binding named `Math` — name a math component `TeX`.

## Babel / compile-time instrumentation

- **JSX visitors in other plugins never fire under babel-preset-solid.** The Solid compiler
  visits each outermost `JSXElement`, compiles the whole subtree internally, and replaces it —
  the shared traversal never descends into JSX children. Do all JSX stamping in `Program.enter`
  with an explicit `path.traverse`, which runs before any replacement (`@locator/babel-jsx` is
  built the same way). Diagnostic corollary: a plugin can be *instantiated* and its `Program`
  visitor run while its JSX visitors never do — when verifying a babel plugin, instrument the
  traversal, not the instantiation.
- **vite-plugin-solid's `babel` option only sees `.jsx/.tsx`.** Plain `.ts` model files — where
  the dataflow lives — are never processed by its babel pass. Ship instrumentation as a
  standalone Vite plugin (`enforce: "pre"`, own `@babel/core` pass, dev-only, content-sniff to
  skip files with nothing to stamp): it covers all extensions and decouples from Solid entirely.
- **Enable the `jsx` parser plugin only for `*.jsx/*.tsx`.** In plain `.ts`, jsx parsing makes
  `<T>expr` type assertions ambiguous.

## Vite HMR routing

- **`import.meta.hot.accept(dep, cb)` works only in a module that directly imports `dep`.**
  Registered anywhere else it silently does nothing and the update full-reloads.
- **Every import path to a changed module must reach an acceptor.** One stray secondary import
  (the sim engine importing a single shader constant) routes the update around your handler and
  up to the root → full reload. Sever secondary paths (pass values through constructors) or
  accept on each.
- **A self-accepting module absorbs propagation** for un-handled updates beneath it — the
  dataflow module's bare `hot.accept()` is why edits to shared model code hot-apply instead of
  bubbling past `main` to a reload.
- **Comment-only edits can produce byte-identical output**, so solid-refresh swaps nothing — no
  remount side effects run. Don't interpret a no-op hot update as evidence the mechanism works.
- **Worker files and durable-root modules force full reloads** by construction (Vite can't
  hot-swap a live worker; the durable wiring module is everything's ancestor). Practical rule
  when driving a live experiment: don't edit `*.worker.ts` or `store.ts` mid-run.
- **HMR ordering hazard for adopted resources:** the replacement component's setup can run
  *before* the old component's cleanup. Cleanup of a shared durable resource must be conditional
  ("still mine?") or unnecessary by design — never take the canvas back from your successor.
- **Never `optimizeDeps.include` a workspace-linked package.** The dep-optimizer cache is keyed
  by the lockfile, not file contents; the linked package is served stale after every rebuild.
  (Related: the dep scanner cannot see through virtual modules — a plugin-injected bare import is
  discovered at request time, costing one reload on cold start; acceptable, or pre-bundle for
  registry consumers only.)
- **`vite preview` resolves the config with `command: "serve"`** (plus an `isPreview` flag —
  key environment-dependent `base` on `command === "build" || isPreview`, never on command
  alone), and `apply: "serve"` plugins are active under preview too. The failure mode is
  maximally confusing: with the wrong base, the SPA fallback serves `index.html` for every
  asset URL — status 200, content HTML — while requests carrying `Sec-Fetch-Dest: script`
  (real browsers) correctly refuse the fallback and 404.
- **Source-first workspace packages that ship JSX work end-to-end** — and for a specific
  reason worth knowing: vite-plugin-solid compiles JSX for any served `.tsx` and only *disables
  solid-refresh* for ids containing `/node_modules/`. pnpm workspace links resolve to the real
  `packages/<pkg>/src/` path, so a linked component library (`aiui-viz`) gets both JSX
  compilation *and* HMR component boundaries in every consumer. Verified live: editing the
  library's `cell-view.tsx` hot-updates a running app with no reload, sim state intact.
- **`import.meta.env.*` is substituted when a package is *built*.** Prebuilt library code can
  never read its consumer's env — the full write-up is in the
  [web intent tool internals](./web-intent-tool#how-the-plugin-gets-the-tool-into-the-page-subtle);
  the general rule: runtime configuration for prebuilt code must travel through runtime channels
  (injected globals, plugin-generated modules).

## Ecosystem status (transient — recheck before relying on it)

- **LocatorJS on Solid 2.0:** `@locator/babel-jsx` works but emits `file::<element-index>` only;
  `@locator/runtime` ships precompiled Solid 1.x (`solid-js/web` import) and crashes the dep
  optimizer; `solid-devtools` pins solid-js `^1.9`. Hence the in-repo source locator
  (`data-source-loc` with real line:col, dependency-free bar `@babel/core`), now owned by the dev
  overlay (`packages/aiui-dev-overlay/src/source-locator.ts`, enabled via `aiuiDevOverlay({ locator })`).
- **The 2.0 toolchain that works together:** `solid-js@next` + `@solidjs/web@next` +
  `vite-plugin-solid@next` (bundles a 2.0-compatible solid-refresh). TypeScript ≥ 5.x with
  `jsx: "preserve"`, `jsxImportSource: "@solidjs/web"`.

## Workers, GPU, and long computation

- **Cancellation needs a macrotask.** `await Promise.resolve()` between chunks never yields to
  message delivery; `await new Promise(r => setTimeout(r, 0))` does. A worker that only
  micro-yields is uncancellable in practice.
- **`import type` from a mixed barrel is safe in workers.** Under `verbatimModuleSyntax`,
  type-only imports are fully erased — a worker importing protocol *types* from a barrel that
  also re-exports JSX components never drags the component code (or solid-js) into its bundle.
- **Don't emit the final value as both a partial and `done`** — it double-records in any
  accumulating consumer (aztec's frame ring collected 65 frames for 64 steps). Gate the last
  partial or let `done` carry it, not both.
- **Browsers cap live WebGL contexts per tab (~8–16, oldest silently destroyed).** This is what
  forces the `hibernate` policy (read state back to CPU, release the context) in any multi-page
  design that keeps several GPU notebooks warm.
- **Readback and screenshot disagree diagnostically** — a blank canvas with healthy readback is a
  compositing problem; blank both is a produce/draw problem. (The full decision table lives in
  the archived *observable web workers* notes, `archive/agentic_ui_workflow/` in the repo.)

## Driving a live app from an agent

- After calling a tool that mutates state, **await a task boundary before reading** (`report()`)
  — see the batching entry above; same-tick probes produce convincing false alarms ("seek is
  broken" cost an hour; it wasn't).
- The demo apps' own tool surfaces (`window.__morpho`, `window.__aztec`) are the intended
  verification instrument: discover with `.tools`, act with `.call`, observe with `.report()`,
  and map anything on screen to source and dataflow with `.call("locate", { selector })`.
