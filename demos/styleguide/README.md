# demos/styleguide

The design system's reference sheet, as a demo: every role, token, and component of
`@habemus-papadum/aiui-design` rendered on one page — the quick look, and the visual
acceptance test for any design change. It rides the gallery like every other demo (the
`aiui.sitePage` marker; `pnpm demo`, then `/styleguide`) and runs standalone
(`pnpm -C demos/styleguide dev`).

The sheet exhibits the REAL components where it can — the control widgets and cell states
come from aiui-viz over a tiny control surface — and static specimens where a live one would
need a backend (the dock row, the log). The design language itself is
[`packages/aiui-design/DESIGN.md`](../../packages/aiui-design/DESIGN.md); change it there,
make the package follow, and check here.
