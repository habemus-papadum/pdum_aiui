# Frontend: style guide

The fourth frontend document — where [concepts](./frontend-for-agents) says *what the pieces
are*, [design choices](./frontend-design-choices) says *how they're built and why*, and the
[ledger](./frontend-hard-won) records *what it cost to learn*, this page says **how a notebook
page should look and read**: the conventions an author (human or agent) follows so every page in
a lab feels like one publication. The reference implementations are the notebooks in
`demos/gallery`; the components live in `@habemus-papadum/aiui-viz`.

## Plumbing and porcelain

The library splits along a deliberate seam:

- **Plumbing** — dataflow semantics, no opinions about appearance: `cell`, `CellView`'s
  *behavior*, the worker protocol, `durable`, `agentToolkit`. This is the layer the
  [design-choices](./frontend-design-choices) document is about.
- **Porcelain** — the conveniences this style guide is about: the Plot bridge
  (`aiui-viz/plot`), the Mosaic bridge and DuckDB glue (`aiui-viz/mosaic`, `aiui-viz/duckdb`),
  the page chrome, math, and theming machinery (`aiui-viz/site`). Each porcelain surface sits
  on its own subpath so its heavyweight dependency (Plot, Mosaic, DuckDB-WASM, KaTeX) stays an
  optional peer.

**Porcelain grows by extraction, not speculation.** A pattern is first built and proven inside a
reference notebook (where it may be rough), then promoted to the library once a second page
wants it. `TeX`, `TocRail`, `SiteHeader`, and the Mosaic/DuckDB pair (proven in seismos) all
followed that path. One package holds both layers for now — if porcelain ever outgrows it, the
seam is already drawn.

## Document structure: the page is a short paper

Every notebook page has the same skeleton, in this order:

1. **Title block** — `<h1>` with the notebook name and a one-line thesis under it.
2. **The overview section first** (`§the-laboratory`, `§the-tiling`, …): the *complete*
   dashboard — every visualization and control on screen at load, in a compact grid. A visitor
   who never scrolls has still seen the whole experiment.
3. **Explanatory sections** (`§observables`, `§structure-analysis`, domain sections): prose
   that says what the numbers *mean*, each re-rendering **its own live instance of the same
   widgets** shown in the overview. Double-mounting is free (see
   [design choices](./frontend-design-choices)) and intended: the reader watches the same cell
   from inside the explanation, and controls stay in sync across copies.
4. **`§theory`** — the governing mathematics, honestly tied to what's on screen (the equations
   whose behavior the page demonstrates, ideally with a live-computed quantity linking them).
5. **`§experiments`** — 4–6 concrete things to try, each naming the **exact controls** to
   touch (`regrow`, `kill k`, the `fold` scrubber). This section turns a viewer into an
   experimenter; it is not optional.

Mechanics: each section is `<section id="kebab-slug">` with one `<h2>`. Ids are stable (they're
anchor targets and TOC keys). Prose lives in the page component next to the panels it explains —
it is part of the notebook, not decoration. Canvases are **durable singletons** and appear only
in the overview; everything else may double-mount.

## Table of contents

Use `TocRail` (`aiui-viz/site`) on every page: it builds itself from the page's
`section[id] > h2` headings after mount, highlights the section in the reading band via
IntersectionObserver, and hides below ~1280px. Conventions:

- Section titles are short and lowercase (`theory`, not `The Underlying Theory`) — the rail is
  a map, not a syllabus.
- 4–6 sections is the sweet spot; if a page needs more, it probably wants to be two pages.
- The rail is the page's *outline*; the site header is the *collection's* nav. Don't mix the
  levels — no cross-page links in the rail, no section links in the header tabs.
- Layout: the rail is a sticky grid column beside the content (not fixed-position), so it never
  overlaps and needs no coordinate math.

## The site header

`SiteHeader` (`aiui-viz/site`) on every page, fed from one app-level module (the demo's
`src/site/nav.ts`): brand, the tab list, GitHub/docs links. Rules:

- **Every tab carries a one-line descriptor** ("reaction–diffusion lab") — the tabs are how a
  visitor learns the site has more than one experiment; a bare name doesn't teach that.
- Hrefs are **relative** (`./`, `./aztec.html`) so pages survive a hosting prefix (the demo
  publishes under `/aiui/`).
- Adding a page = one entry in `nav.ts` + one Vite entry. Nothing else.

## Mathematics

Use `TeX` (`aiui-viz/site`; KaTeX under the hood, optional peer):

- Display math for the equations a section is *about*; inline math for symbols in prose.
- Math must be **honest**: every displayed equation is one the page actually demonstrates or
  computes against — no decoration mathematics. The gold standard is an equation with a
  live-computed quantity beside it (the measured wavelength next to the Gray-Scott system; a
  fitted exponent next to a power law).
- The component stamps `data-tex` with the raw source — part of the DOM attribution contract
  (selections over rendered math recover their TeX). Don't bypass the component for one-off
  `katex.render` calls; you'd lose the stamp.
- `throwOnError: false` is the component default: a TeX typo renders red instead of blanking
  the page.

## Plotting

**Observable Plot is the default** for statistical graphics, always through the `PlotFigure`
bridge (`aiui-viz/plot`) — reactive options in, figure out, one seam around the imperative
library. Conventions (the [dataviz procedure](./frontend-design-choices) governs color):

- Options are a function reading cells/signals — including the color-mode signal — so charts
  re-render on data *and* theme changes.
- Series colors come from the app's validated per-mode palette (the demo's `src/site/theme.ts`);
  Plot cosmetics (axis ink, rule gray) come from the same module. Never hardcode a hex in a
  component.
- d3 may contribute *scales and tick math* to plain JSX (the regime atlas) — but no
  d3-selection; Solid renders the SVG.
- Simulation canvases are not charts: they render as self-contained dark **figures** (journal
  plates) identical in both color modes, framed by the panel border.

**Mosaic + vgplot is the direction for dataframe-shaped work** — cross-filtering, aggregation
over large tables, DuckDB-WASM-backed exploration. The division of labor: Plot for a chart
*of a cell's value*; Mosaic when the data lives in a **table** and views coordinate through
**selections** (brushing one view filters the others, aggregation pushed down to the database).
The **seismos** notebook is the reference for this stack (Parquet → DuckDB-WASM → Mosaic
selections → coordinated vgplot views, with a live Gutenberg–Richter fit off the filtered
selection) and its bridge follows the same island discipline as `PlotFigure`:
Mosaic owns its plots' internals and reactivity; Solid renders the shells; the shared Selection
objects and the database connection are durable roots. The proven pattern has graduated:
`aiui-viz/mosaic` exports `MosaicView` (coordinator + reactive directive-list spec in, a
connected Plot out, marks disconnected on dispose), and `aiui-viz/duckdb` exports
`instantiateDuckDB` + `fetchWithProgress` — the app keeps only the four `?url` asset imports
that make the wasm/worker bundles its own same-origin files (a library cannot own those; see
the module docblock). Both are optional-peer subpaths, like `aiui-viz/plot`.

## Phones and desktops

A notebook is **one component tree, reflowed** — never a separate mobile build, and never a
JavaScript `isMobile` branch. A CSS media query *is* the device-conditional logic, and unlike a
runtime check it cannot drift from the viewport it reasons about. The reference notebooks all
render on a phone from the same markup the desktop uses.

- **Desktop is the base; narrow screens are overrides.** Keep the wide-screen rules as the
  unqualified declarations and layer phone changes inside `@media (max-width: …)` blocks, so the
  desktop layout stays byte-identical — the same "never an automatic flip" discipline as theming.
  Prove it: screenshot the page at ~1440px before and after and confirm it is unchanged.
- **Fluid first; breakpoints only for structural switches.** Prefer intrinsic sizing —
  `minmax()`, `clamp()`, `auto-fit`, `fr`, `%`, `max-width` caps — over fixed pixel widths, so a
  layout degrades instead of overflowing. A fixed two-column track (`540px 1fr`) becomes
  `minmax(0, 540px) minmax(0, 1fr)`: identical when there's room, shrinking when there isn't. Add
  a breakpoint only where the *structure* must change — the overview's figure/data split stacking
  to one column, a paired chart going from side-by-side to stacked.
- **Breakpoints belong to content, not device names.** Put each one where *this page's* content
  stops fitting, not at a named phone width. The existing ones are content-derived: the `TocRail`
  hides below ~1280px, seismos collapses its dashboard at 860px, circle stacks its board at 600px.
  Target the CSS-pixel band **360–414** as the phone floor (the viewport meta maps device pixels
  to CSS pixels; device-pixel-ratio governs sharpness, not layout) — read cleanly across that band
  and it works on essentially every phone.
- **Imperative islands re-fit themselves — let them.** The simulation canvases and the pencil
  `PencilSurface` size to their container through a `ResizeObserver`, so a CSS reflow that changes
  an island's box is enough; the resize path is the same one a desktop window-resize already
  exercises. Give a stacked drawing surface an **explicit height** so its canvas has a box to
  observe. Reach for JavaScript only when an island genuinely cannot re-measure, or the
  *interaction itself* must differ — not merely because the layout changed.
- **Overlays that float beside a wide figure must rejoin the flow on a phone.** Circle's readout
  and dock are `position: absolute` over a wide board on desktop; on a ~360px board that same panel
  buries the canvas, so below the breakpoint they become `position: static` and stack vertically
  (toggle, square stage, score, dock). An overlay that's fine over a wide plate swallows a narrow
  one.
- **`touch-action`.** A drawing surface keeps `touch-action: none` (or the browser eats pen/finger
  drags as scroll); once it shares a stacked board with normal panels, the *container* must allow
  `touch-action: pan-y` so the page still scrolls when a touch lands off the canvas.
- **Preview on the real thing.** Drive an actual browser at a phone viewport — Chrome DevTools
  device/responsive mode, or the session browser via the Chrome DevTools MCP (`emulate` /
  `resize_page` + a screenshot loop) — and sweep 360/390/414, then re-shoot at ~1440px to prove
  desktop is untouched. A real phone over the LAN (`vite --host`, then the machine's LAN IP on the
  same Wi-Fi) is the gold standard.

## Theming

Covered in depth in [design choices §8](./frontend-design-choices); the style-guide rules:

- Pages follow the **system** color scheme; no toggle — the default. A *page* may deviate
  deliberately when its content demands it (seismos defaults to light with a persisted toggle
  because its epicenter map reads best on a light surface — the other notebooks follow the
  system); the deviation is documented where it was decided, in that page's NOTES.md, and the
  policy anchor is the page's own head script.
- All stylesheet color goes through `:root` tokens (dark default, light under the media query).
  Literal colors (charts, SVG strokes) read the app's theme module, keyed on `colorMode()` from
  `aiui-viz/site`.
- Palettes are **validated per mode** against that mode's actual surface — never an automatic
  flip. Figure colors (canvas + its legend chips) are cross-mode constants; panel-chart colors
  are per-mode.

## Voice

Prose is compact, declarative, and specific to what's on screen ("the frozen-fraction curve is
that fact as a number"), in sentence-case headings. Numbers in prose are live reads of cells
wherever possible, never copied constants. Explain *meaning*, not mechanics — the code explains
mechanics.
