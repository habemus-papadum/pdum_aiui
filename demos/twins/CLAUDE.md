# demo: twins

**This demo is the composability worked example** (one slice, two instances): the oscillators
come from `demos/oscillator` (a workspace slice library), instantiated under
`scope("left")`/`scope("right")` in `src/model/store.ts`. Keep that shape — the demo exists to
show scoped slice reuse; don't inline the slice's code into the app.

An in-repo demo app, scaffolded by `pnpm new-demo` from the same starter template
`create-aiui` ships. Its visible content — the banner, the rose — is **placeholder scenery meant
to be replaced** by whatever this demo is for. Be bold about rebuilding the page; be careful about
the wiring underneath.

**Reset to a blank canvas (mechanical — no code reasoning), applied under `src/` only:**
1) delete every file whose first line contains `<aiui-scenery-file>`; 2) in the remaining
`src/` files, delete each block from a line containing `<aiui-scenery>` through the next
line containing `</aiui-scenery>`, inclusive of both marker lines; 3) `pnpm typecheck &&
pnpm test` (a blank app passes both). Touch nothing else — docs like this one merely mention
the markers.

It differs from a scaffolded sandbox in exactly two ways, both deliberate:

- `@habemus-papadum/*` deps resolve through `workspace:^` — you are editing the real packages
  next door, live, with no build step. A change to `packages/aiui-viz` shows up here on save.
- It lives in this repo's git history. Commits here are commits to pdum_aiui.

Ground rules (the same ones the starter ships with):

- **Don't remove the integration.** The `aiui()` plugin in `vite.config.ts` stamps JSX with
  `data-source-loc` and injects `cell()`/`control()`/`action()` identities — the handles the
  intent client's screenshot/selection attribution reads. The loop stops working without it.
  (And never hand-write a `data-source-loc`/`data-cell-loc` — locations are compiler output.)
- **Keep the architecture's split.** `src/model/store.ts` holds the *durable roots* AND the
  **control surface**: user-movable parameters are `control({ value, min, max, … })` with a real
  doc comment (the compiler injects the name from the binding and lifts the comment as the
  description). Internal state stays `durableSignal()`/`durable()` — the surface is curated.
  `src/model/graph.ts` is *disposable logic*: the cell graph, built by `hotCellGraph()` and
  rebuilt over the roots on every hot edit. UI components in `src/ui/` are freely hot-swappable,
  read cells through the `graph()` accessor (never by importing one directly), and bind controls
  through `ControlSlider`/`ControlToggle` (bounds from the control's meta — never re-state
  min/max in JSX) or a hand-rolled binding for shapes those don't fit.
- **Declaring IS exposing.** Every `control()` is settable and every `action()` is a real named
  agent tool automatically via `registerStandardTools` (`report`/`set`/`locate` + one tool
  per action). Do NOT hand-write get-params/set-params tools; reserve `kit.registerTool` for the
  rare genuinely-bespoke case.
- **Test the surface with the cells.** `resetControlSurface()` in afterEach, build cells inside
  `cellHarness`, probe each input.
- Run the dev server with `pnpm dev` from this directory (plain `vite`); the intent client
  reaches the channel through the channel-served `/intent/` page or the side panel, so the dev
  server needs no channel wiring of its own.

Methodology: [docs/guide/frontend-for-agents.md](../../docs/guide/frontend-for-agents.md).
