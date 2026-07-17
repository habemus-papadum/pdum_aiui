# demo: july09

An in-repo demo app, scaffolded by `pnpm new-demo` from the same starter template
`create-aiui` ships. The starter's placeholder scenery has been **stripped back to a blank
canvas**: the page renders an empty `div` and the cell graph holds no cells. The structure underneath is
intact and is what to build into. Be bold about filling the
page; be careful about the wiring underneath.

It differs from a scaffolded sandbox in exactly two ways, both deliberate:

- `@habemus-papadum/*` deps resolve through `workspace:^` — you are editing the real packages
  next door, live, with no build step. A change to `packages/aiui-viz` shows up here on save.
- It lives in this repo's git history. Commits here are commits to pdum_aiui.

Ground rules (the same ones the starter ships with):

- **Don't remove the integration.** The `aiui()` plugin in `vite.config.ts` stamps JSX with
  `data-source-loc` and injects `cell()` identities — the handles the intent client's
  screenshot/selection attribution reads. The loop stops working without it.
- **Keep the architecture's split.** `src/model/store.ts` holds the *durable roots* (signals
  created via `durableSignal()` — they survive hot edits). `src/model/graph.ts` is *disposable
  logic*: the cell graph, built by `hotCellGraph()` and rebuilt over the roots on every hot edit,
  plus the agent tools registered next to the capabilities they expose. UI components in `src/ui/`
  are freely hot-swappable and read cells through the `graph()` accessor, never by importing one
  directly. New state goes in store.ts; new dataflow goes in graph.ts as `cell()`s rendered
  through `CellView`.
- **Expose what you build.** When you add an operation the user can do, register a matching agent
  tool in `graph.ts` (`agentToolkit`) so your future self can drive and inspect it.
  `registerStandardTools(kit)` already gives you `locate` and the `cells` attribution table.
- Run the dev server with `pnpm dev` from this directory (`bin/aiui vite dev` — it injects the
  channel port as `VITE_AIUI_PORT`). Plain `vite` also serves the app, but the intent tool won't
  find the channel.

Methodology: [docs/guide/frontend-for-agents.md](../../docs/guide/frontend-for-agents.md).
