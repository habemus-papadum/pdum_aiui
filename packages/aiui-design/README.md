# @habemus-papadum/aiui-design

The aiui design system: cotton paper, slate ink, editorial type, and a skin for every stable
class aiui-viz emits — one import for a notebook page or a tool surface. It dresses every
page this repo serves (the gallery and its notebooks, the console, the intent panel, the
starter a scaffolded app begins from). Other consumers of the aiui packages may use it or
ignore it: aiui-viz ships no CSS and depends on nothing here.

Three artifacts:

- **[DESIGN.md](./DESIGN.md)** — the design language: principles, tokens, type roles,
  component anatomy, the tool-chrome rules. The contract; read it before styling anything.
- **`src/`** — the CSS: `tokens.css` (custom properties), `fonts.css` (the faces,
  self-hosted via `@fontsource`, all OFL), `site.css` (reset + editorial element defaults +
  the skin for aiui-viz's classes + the site and notebook chrome, on cascade layers). The one
  piece of JavaScript is the theme module — the palette as literals for canvases, SVG, and
  Observable Plot options.
- **`demos/styleguide`** in this repo — every role, token, and component rendered on one
  page: the quick look and the visual acceptance test for any design change.

## Consuming

```sh
npm install @habemus-papadum/aiui-design
```

```ts
import "@habemus-papadum/aiui-design/site.css";
```

That is it. Everything aiui-viz renders (`CellView`, `CellText`, the control widgets, the
scrub pill, `SiteNav`, `TocRail`, `TeX`, `Lens`, `PageBoundary`'s fault card, the Mosaic
inspector and views bar) arrives styled; plain HTML (headings, prose, tables, code) lands in
the system too. Add your own CSS on top — the sheet runs on cascade layers, so unlayered
site rules win without specificity games. `tokens.css` and `fonts.css` are importable alone
if a page wants the palette without the opinions.

```ts
import { CHART, PLOT, plotStyle, TOKENS } from "@habemus-papadum/aiui-design";

Plot.plot({ style: plotStyle(), marks: [Plot.lineY(rows, { stroke: CHART.blue })] });
ctx.fillStyle = TOKENS.plate;
```

The theme module is light only; `chart()` and `plot()` stay accessor-shaped so a chart's
option memo written against them needs no change if a second palette ever slots in.

## Developing

Change flow: edit `DESIGN.md` first, make `src/` follow, check `demos/styleguide` (it rides
the gallery: `pnpm demo`, then `/styleguide`), and let the version lockstep carry it. The
test next to the theme module pins the literal palette to the CSS ladder and checks the
contrasts the design document claims.
