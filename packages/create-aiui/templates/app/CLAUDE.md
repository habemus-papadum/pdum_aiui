# an aiui starter app

This directory was scaffolded by `create-aiui`. It is the user's sandbox: a SolidJS 2.0 (beta)
app wired for the aiui loop, whose visible content — the banner, the rose — is **placeholder
scenery meant to be replaced** the moment the user describes the app they actually want. Be bold
about rebuilding the page (the banner included); be careful about the wiring underneath.

## Reset to a blank canvas

Every piece of placeholder scenery is fenced with markers, so resetting the app is a **mechanical
deletion — no code reasoning required**. If the user asks for a blank app (or you want a clean
canvas before building theirs), do exactly this and nothing more:

1. **Under `src/`, delete every file whose first line contains `<aiui-scenery-file>`.**
2. **In every remaining file under `src/`, delete each block** from a line containing
   `<aiui-scenery>` through the next line containing `</aiui-scenery>`, **inclusive of both
   marker lines**. (Only `src/` — docs like this one merely *mention* the markers.)
3. Verify: `npm run typecheck && npm test` (both pass on the blank app; tests report
   "no tests" green).

The result compiles and runs: an empty page, an empty cell graph over empty durable roots, the
intent tool still mounted, the standard agent tools still registered. Do not "clean up" anything
else — unused-looking scaffolding outside the fences is the app's wiring.

(For authors editing the scenery instead of deleting it: keep the invariant that fenced code is
only ever referenced from other fenced code or fenced files, so step 1+2 can never break the
blank app.)

## The build order (the playbook)

When building the user's real app, work in the four-layer order of the
[frontend playbook](https://habemus-papadum.github.io/pdum_aiui/guide/frontend-playbook), thin
vertical slices first:

1. **Pure functions** (`src/model/*.ts`, like the rose's math) — domain logic, no framework, no
   time; unit-test exhaustively (see `rose.test.ts` for the shape).
2. **Cells** (`src/model/graph.ts`) — the computation boundaries: fetches, workers, streams,
   cancellation; test headless with `@habemus-papadum/aiui-viz/testing` (see `scenery.test.ts` —
   one `whenReady` probe per input per cell).
3. **Components** (`src/ui/`) — pure readers rendering cells through `CellView`.
4. **Application** (`src/ui/App.tsx`) — layout, sections, keyboard modes.

Ground rules:

- **Don't remove the integration.** The `aiuiDevOverlay()` plugin in `vite.config.ts` mounts the
  intent tool and connects it to this session's channel; its `locator` option stamps JSX with
  `data-source-loc` and injects `cell()` identities. The loop stops working without it. (And
  never hand-write a `data-source-loc`/`data-cell-loc` — locations are compiler output.)
- **Keep the architecture's split.** `src/model/store.ts` holds the *durable roots* (signals
  created via `durableSignal()` — they survive hot edits; the user's interaction state is the most
  precious thing in the HMR contract). `src/model/graph.ts` is *disposable logic*: the cell graph,
  built by `hotCellGraph()` and rebuilt over the roots on every hot edit, plus the agent tools
  registered next to the capabilities they expose. UI components in `src/ui/` are freely
  hot-swappable and read cells through the `graph()` accessor, never by importing one directly.
  New state goes in store.ts; new dataflow goes in graph.ts as `cell()`s rendered through
  `CellView`.
- **Expose what you build.** When you add an operation the user can do, register a matching
  agent tool in `graph.ts` (`agentToolkit`) so your future self can drive and inspect it.
  `registerStandardTools(kit)` already gives you `locate` and the `cells` attribution table.
- The dev server runs via `npm run dev` (which is `aiui vite dev` — it injects the channel port
  as `VITE_AIUI_PORT`). Plain `vite` also serves the app, but the intent tool won't find the
  channel.
- This is a standalone git repo scaffolded for the user; commit freely — history here belongs to
  their sandbox and goes nowhere else.

Methodology docs (user guide, playbook, design choices, hard-won details):
<https://habemus-papadum.github.io/pdum_aiui/guide/frontend-user-guide>
