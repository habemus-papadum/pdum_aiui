# Semantic SVG lab

Read the root AGENTS.md, this demo's README.md, the semantic SVG proposal, and
skills/aiui-architecture/SKILL.md before extending this experiment.

This is an in-repo demo, never a standalone repository or published package.
Preserve its CI-managed version. Keep experimental SVG abstractions local until
another domain has demonstrated their reuse. Keep diagram geometry, physical
facts, and hit regions distinct.

Pure logic belongs in the domain modules (circuit, markup, contact, statics, circle-pair, structure, dc-circuit) and their projections; durable roots and
the declared operation surface in model/store.ts and the per-experiment stores; disposable cells in
model/graph.ts; drawing and input in ui/. Every declaration uses appScope.
Model edits cross the revision-checked operation used by both the UI and tools.
Navigation does not create undo steps or invalidate circuit analysis.

Run typecheck, model/cell tests, targeted Biome, a Vite build, and browser tests
for interaction changes. Use the gallery card without importing store/graph.
The README records experiment boundaries and the questions to review next.

The contact experiment uses the shared equation/SVG knob controller. Keep its
restricted geometry and numerical guarantees explicit. Beam statics is a
separate ideal, closed-form example. General constraint solving and dynamics
remain outside these interaction mockups.

The structure study permits member/support edits and live position previews. Keep
its numerical rank policy and infinitesimal-motion interpretation explicit; do not
assign unique forces to mechanisms or indeterminate structures. Source references
must survive alternate projections, and a proposed topology edit is revision-guarded.

The DC circuit study keeps layout out of its electrical graph. Connections are
explicit terminal references; crossings do not connect. Derived nets may merge or
split, while inspected terminal identity persists. Preserve partial mathematical
facts: a passive floating island has unknown absolute voltages but zero branch
currents. Shared diagnostic/capture adapters remain local.
The user has reviewed both studies and requested consolidation. That record is
[semantic-svg-lessons.md](../../docs/proposals/semantic-svg-lessons.md). The study
is now paused: retain the examples, and resume implementation only in response to
a new user request. Additional studies and a public package are outside the
completed exploration.
