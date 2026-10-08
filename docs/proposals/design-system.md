# The design system: one look for the notebooks and the tool

Status: **DECIDED and IN PROGRESS, 2026-10-08.** The owner asked for the repo's demos, the
gallery, and the web tool to move from the dark journal to an editorial, light-only system
— cotton paper, slate ink, type carrying the hierarchy, one accent — and approved the
proposal below after a specimen sheet. The language itself is
[`packages/aiui-design/DESIGN.md`](../../packages/aiui-design/DESIGN.md); this page records
the decisions, what moves, and in what order.

## Decisions

- **A public package, `@habemus-papadum/aiui-design`** (`packages/aiui-design`), CSS first:
  `tokens.css`, `fonts.css`, `site.css` on cascade layers (reset, base, chrome, components,
  notebook), and a theme module with the palette as literals for canvases, SVG, and Plot.
  One import dresses a page. `demos/journal` retires into it.
- **Core stays untouched.** aiui-viz ships no CSS; it emits stable class names and this
  package skins them. Published widgets that carry CSS strings (the voice dock, the tool
  log, the trace debugger, the slides deck, the oracle and live strips, the pencil remote)
  keep their neutral look everywhere and read prefixed `--aiui-*` hooks with fallbacks, so
  they are of a piece inside our pages and inoffensive elsewhere. Additive, never breaking.
- **Light only.** No dark palette, no toggle, no head stamp. The system-following journal
  (design choices §8, 2026-08-12) is superseded for these pages; aiui-viz's `colorMode`
  signal stays for consumers who theme per system.
- **The plate rule stays.** Simulation canvases and boards are dark plates on the paper,
  framed by a hairline (no shadows). A landing card's preview is a plate.
- **Chrome is monochrome; data carries the color.** Per-demo data palettes are untouched.
  The shared chart trio becomes blue, green, amber: purple left it, because purple is the
  accent and a series must never read as interactive.
- **Faces.** Cormorant Garamond for reading, one step larger than a sans scale and at weight
  500 (the owner found the reference size too small); Fraunces (variable, OFL) for display
  — section titles, the wordmark — with its soft and wonky axes and discretionary ligatures;
  Libre Franklin for labels; Georgia for numerals via a digit-routing face; system mono
  without code ligatures. The display face replaced a licensed one the reference used; this
  package ships only OFL fonts and can be public.
- **Accent: indigo** (`#4b3fc4`). Status colors moss, ochre, brick; status is a dot or a
  word's color, never a fill on a healthy page.
- **The starter template adopts the package**, so a scaffolded app begins in the system;
  deleting one import line opts out. This is the only downstream-visible change.
- **`apps/` was retired first** (commit `d3ed634d`): cc-miner and cc-assay left for their
  own repo with the eviction tooling, so the restyle has no product to drag along.
- **The specimen is a demo.** `demos/styleguide` renders every role, token, and component
  through the real aiui-viz widgets over a tiny control surface, and rides the gallery like
  any notebook — the visual acceptance test for any design change.
- **Lineage.** The palette anchors are Observable Framework's cotton theme (ISC). Nothing
  else is cited.

## The work, in order

| # | Tranche | Lands as |
| --- | --- | --- |
| 1 | retire `apps/` | `d3ed634d` |
| 2 | `packages/aiui-design` + `demos/styleguide` | one commit |
| 3 | the gallery shell and every journal demo; `demos/journal` deleted | one commit |
| 4 | the standalone-surface demos (live, twins, walkthrough, dna-script, motherduck-lab) and the starter template | one commit |
| 5 | the web tool: console, trace debugger, intent panel, dock, tool log, widget hooks, pencil chrome | one or two commits |
| 6 | docs, skills, memory | one commit |

Each tranche is checked in the session browser at desktop and phone widths before it lands.

## Migration notes (tranche 3)

The journal's tokens map onto the ladder mechanically, then each page gets a reading pass:

| journal | design |
| --- | --- |
| `--bg` | `--surface` |
| `--panel` | `--surface-raised` |
| `--panel-border`, `--row-border`, `--grid-line` | `--ghost` (quiet) or `--hairline` (structural) |
| `--text`, `--text-heading` | `--ink` |
| `--text-secondary`, `--text-dim` | `--ink-muted` |
| `--text-muted`, `--text-faint` | `--muted` |
| `--accent`, `--accent-strong` | `--accent` |
| `--btn-*` | the `.btn` roles |
| `--figure-bg` | `--plate` |
| `--error-*` | `--alarm`, `--alarm-wash` |
| `--ok` | `--ok` |
| `mode()` / `isDark()` / `Record<Mode, …>` palettes | one light set; `chart()` and `plot()` from the package |

Classes two or more demos share (`.panel`, `.tiles`, `.layout`, `.page-section`, `.prose`,
`.experiments`, `.ctrl`, `.regime-table`, `.legend`) moved into the package's notebook layer
with the journal's geometry and the system's voice; a demo's own classes stay in its
`page.css`, now written against the new tokens.
