# demo: walkthrough

An in-repo demo wired to the workspace (`workspace:^`). **This one is a teaching artifact**: the
playbook (docs/guide/frontend-playbook.md) built stage by stage, with steps 1-3 preserved as
standing pages beside the finished app. Read WALKTHROUGH.md first.

Ground rules beyond the usual (see the starter template's CLAUDE.md for those):

- **The steps must stay truthful.** step1 uses only `src/lib`; step2 adds `src/model` with crude
  rendering; step3 adds `src/ui`; the index adds layout + keys. An edit that leaks a later
  layer into an earlier step breaks the demo's whole point.
- **Declaring IS exposing.** Controls/actions in `src/model` surface via `registerStandardTools`
  (report/set + one tool per action) — never hand-write get/set tools here.
- **The graph takes its worker as a parameter** (`buildGraph(worker)`) so graph.test.ts can run
  headless with a stub. Keep that seam when adding cells.
- Tests: physics in `src/lib/diffusion.test.ts`, wiring in `src/model/graph.test.ts`
  (`resetControlSurface` in afterEach; probe every control).
