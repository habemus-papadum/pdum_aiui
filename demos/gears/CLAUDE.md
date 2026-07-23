# demo: gears

A live involute-gear studio: two spur gears in kinematic mesh (gear B locked to
gear A by the ratio and phase, so the teeth stay engaged at every angle), the
line of action with its sliding contact point, and a single-tooth studio — all
pure geometry, no physics. A real, maintained demo — **not** starter scenery.

## Run the loop

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
```

## The dual shape (app + library)

- `src/main.tsx` — the standalone entry: journal chrome + `./page`.
- `src/page.tsx` — the `SitePage` the gallery shell mounts (the `aiui.sitePage`
  marker in package.json is how it's discovered). Page-owned styles in
  `src/page.css` (all scoped under `.gears`); shared chrome from
  `@habemus-papadum/aiui-journal`.
- `src/card.tsx` — the landing-card `DemoCard`: a blurb + a live meshing-gears
  preview, built from the pure geometry only (no store/graph).
- `src/index.ts` — the library barrel: control surface, graph accessor,
  widgets, the pure gear math.

## Ground rules

- **Everything is scoped.** `gearsScope = scope("gears")` (model/store.ts)
  qualifies every control, durable, cell, and action; the graph key and toolkit
  (`window.__gears`) carry the same slug. New declarations MUST thread it —
  `control({ scope: gearsScope, … })`, `gearsScope.durable(…)`,
  `cell(deps, compute, { scope: gearsScope })`, `action({ scope: gearsScope, … })`.
  See the user guide's "Composing bigger apps".
- **Keep the split.** `src/model/store.ts` = the curated control surface
  (teeth, module, pressure angle, drive) — rarely edited. `src/model/graph.ts`
  = the disposable cell graph (gear/mesh geometry) + agent tools.
  `src/model/gear.ts` = pure involute geometry (playbook layer 1), unit-tested
  headless (`gear.test.ts`). `src/ui/` = pure readers; `GearMesh.tsx` is the
  imperative rAF island (the mesh animation) with its own onCleanup.
- **Page CSS is scoped under `.gears`.** The App root is `<div class="gears">`;
  every rule in page.css is prefixed `.gears …` so nothing leaks onto a sibling
  notebook sharing the gallery's document. Shared chrome (panels, sliders,
  buttons, CellView) comes from the journal — don't redefine it here.
- **Don't remove the integration.** The `aiui()` plugin in vite.config.ts
  stamps source locations; the locator also runs under Vitest.

Methodology docs: <https://habemus-papadum.github.io/pdum_aiui/guide/frontend-user-guide>
