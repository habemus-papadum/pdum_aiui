# demo: aztec

Random domino tilings of the Aztec diamond: a streaming shuffle worker feeding
a scrubbable growth-frame ring, a durable canvas plate with the arctic-circle
overlay, and Ryser-permanent checks against the EKLP formula. A real,
maintained demo — **not** starter scenery.

## Run the loop

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
```

## The dual shape (app + library)

- `src/main.tsx` — the standalone entry: journal chrome + `./page`.
- `src/page.tsx` — the `SitePage` the gallery shell mounts (the
  `aiui.sitePage` marker in package.json is how it's discovered). Page-owned
  styles in `src/page.css`; shared chrome from `@habemus-papadum/aiui-journal`.
- `src/index.ts` — the library barrel: store surface, graph accessor, widgets,
  the pure shuffle/permanent math.

## Ground rules

- **Everything is scoped.** `aztecScope = scope("aztec")` (store.ts) qualifies
  every control, durable, cell, and action; the graph key and toolkit
  (`window.__aztec`) carry the same slug. New declarations MUST thread it —
  `control({ scope: aztecScope, … })`, `aztecScope.durable(…)`,
  `cell(deps, compute, { scope: aztecScope })`, `action({ scope: aztecScope, … })`.
  See the user guide's "Composing bigger apps".
- **Keep the split.** `src/store.ts` = durable roots + curated control surface
  (rarely edited). `src/graph.ts` = disposable cell graph + agent tools.
  `src/ui/` = pure readers. `shuffle.ts` / `permanent.ts` / `rng.ts` = pure
  layer-1 math with headless tests; `shuffle.worker.ts` speaks the aiui-viz
  worker-stream protocol.
- **Don't remove the integration.** The `aiui()` plugin in vite.config.ts
  stamps source locations; the locator also runs under Vitest.

Methodology docs: <https://habemus-papadum.github.io/pdum_aiui/guide/frontend-user-guide>
