# @habemus-papadum/aiui-journal

The dark-journal visual identity shared by the notebook demos
(`demos/morphogen` · `aztec` · `seismos` · `circle`) and the gallery shell
(`demos/gallery`). Internal workspace package — never published (the
`demos/oscillator` precedent: a `demos/*` member other demos consume via
`workspace:^`).

Two halves:

- **`@habemus-papadum/aiui-journal`** — theme values that must be JS literals:
  the dataviz-validated categorical chart palette, Observable Plot cosmetics,
  and the dark-mode constants (`mode()` is a constant `"dark"`; the journal is
  dark-only by decision, 2026-07-19).
- **`@habemus-papadum/aiui-journal/styles.css`** — the `:root` design tokens
  and the notebook chrome (panels, sliders, buttons, tiles, CellView/plot
  chrome, `SiteHeader`/`TocRail` classes). A demo's standalone entry imports it
  before its own `page.css`; the gallery shell imports it once for all pages.

The dividing line: this package holds only what two or more surfaces share.
A class one demo owns belongs in that demo's `page.css`.
