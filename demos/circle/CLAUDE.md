# demo: circle

How round can you draw a circle? A vanishing-ink `PencilSurface`
(@habemus-papadum/aiui-pencil) drives a three-signal turn lifecycle; a live
least-squares circle/ellipse fit scores each stroke, with guide/zen/blind
difficulty modes and a KaTeX math section. The pencil package's demo. A real,
maintained demo — **not** starter scenery.

## Run the loop

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
```

## The dual shape (app + library)

- `src/main.tsx` — the standalone entry: journal chrome + `./page`.
- `src/page.tsx` — the `SitePage` the gallery shell mounts (discovered via the
  `aiui.sitePage` marker in package.json). Page-owned styles in `src/page.css`.
- `src/index.ts` — the library barrel: store surface, graph accessor, widgets,
  the pure fitting math.

## Ground rules

- **Everything is scoped.** `circleScope = scope("circle")` (model/store.ts)
  qualifies every control, durable, cell, and action; the graph key and toolkit
  (`window.__circle`) carry the same slug. New declarations MUST thread it —
  `control({ scope: circleScope, … })`, `circleScope.durable(…)`,
  `cell(deps, compute, { scope: circleScope })`,
  `action({ scope: circleScope, … })`. See the user guide's "Composing bigger
  apps".
- **Keep the split.** `src/model/store.ts` = the durable pencil surface + turn
  signals + curated controls (rarely edited). `src/model/graph.ts` = the
  disposable `stats` cell + agent tools. `src/ui/` = pure readers.
  `src/model/circle.ts` = pure layer-1 fitting math with headless tests.
- **Don't remove the integration.** The `aiui()` plugin in vite.config.ts
  stamps source locations; the locator also runs under Vitest.

Methodology docs: <https://habemus-papadum.github.io/pdum_aiui/guide/frontend-user-guide>
