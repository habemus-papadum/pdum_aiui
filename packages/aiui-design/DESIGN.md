# The aiui design language

The design vocabulary for every page this repo serves: the notebook demos and the gallery
that composes them, the console, the intent panel, the trace debugger, the voice dock, and
the starter a scaffolded app begins from. It owns *what things are* and *what they look like*.
How they become CSS lives next door in `src/` — one package, one import — and
`demos/styleguide` renders everything on this page as the visual acceptance test.

> Boundary rule: a sentence that names a CSS selector or a build tool belongs in `src/`. A
> sentence that names a color, a type role, or a component part belongs here.

The palette descends from Observable Framework's **cotton** theme (ISC): warm paper and one
interaction color. The ink is slate rather than cotton's brown, and the typography follows
the working-paper tradition — semantic roles, numerals as a material — adapted to notebook
pages that mix prose with instruments. Other consumers of the aiui packages are free to use
this system or ignore it: aiui-viz ships no CSS, and nothing in it depends on this package.

## Principles

- **A working paper, not a dashboard — even for data.** Generous whitespace, a restrained
  palette, type doing the work.
- **Type carries hierarchy, not boxes.** Almost no borders, fills, shadows, or rounded
  corners. Differentiation comes from face, size, weight, tracking, and color.
- **Chrome is monochrome; data carries the color.** The page's own surfaces, text, rules,
  and controls live on the paper-and-ink ladder. Figures, charts, and simulation plates keep
  their own validated palettes — that is where the color lives, and only there.
- **The accent is a scalpel.** One indigo, used only where interaction lives: links, focus,
  selection, progress, slider thumbs, the active toggle. Never for decoration, never for
  hierarchy, never for a data series.
- **Status is a dot, not a fill.** Three status colors exist (ok, warn, alarm). They appear
  as dots, as a word's color, or as a hairline on an error surface — never as a panel wash
  on a healthy page.
- **Numbers are a material.** Every numeral is set in Georgia on a tabular rail — readouts,
  axis ticks, table cells, prices. Code is the exception: its digits stay in the mono face.
- **Semantic roles over per-element styling.** Every text element maps to a named role. No
  ad-hoc font declarations.
- **Light only.** The page follows no system scheme. There is no dark palette, no toggle,
  and no head stamp. (The reactive `colorMode` signal in aiui-viz remains for consumers who
  theme per system; these pages do not read it.)
- **Fluid, not breakpoint-driven.** Type scales continuously with `clamp()`. Layout
  breakpoints exist only where structure genuinely changes: the nav drawer, the TOC rail,
  a figure/data split stacking on a phone.
- **Maintainable over clever.** Few tokens, clear names, no framework.

## Color

Two anchors — the paper and the ink — and a ladder mixed between them, so the whole palette
retunes from two values. Components pick a rung; they do not invent grays.

| Token | Value | Role |
| --- | --- | --- |
| `--surface` | `#efeee9` | the page — cotton paper |
| `--surface-raised` | 4% ink | panels, code blocks, popovers |
| `--surface-sunken` | 8% ink | inline code, fields |
| `--ink` | `#3d434c` | primary text — slate |
| `--ink-muted` | 60% mix | secondary text, nav items, ledes |
| `--muted` | 50% mix | labels, captions, the TOC, pending states |
| `--hairline` | 30% mix | rules, borders, section lines |
| `--ghost` | 14% mix | faint fills, quiet borders, a panel's edge |
| `--ink-hover` | 85% ink → black | link and icon hover |
| `--accent` | `#4b3fc4` | the one indigo — interaction only |
| `--ok` · `--warn` · `--alarm` | `#2a6e4e` · `#8a5f10` · `#9b3b2a` | status: moss, ochre, brick |
| `--plate` | `#0e1119` | the figure ground — a constant |

**The plate rule.** Simulation canvases, boards, and worker rasters are dark plates mounted
on the paper, framed by a hairline. `--plate` is a constant the page palette never touches,
so a WebGL shader, a canvas island, or a streamed raster renders identically wherever the
page goes and never repaints for the chrome. A landing card's live preview is a plate too.

**Data palettes.** The shared categorical trio for charts drawn on the paper is blue, green,
amber — validated against the raised surface (every series clears 3:1; the three are far
apart for a color-vision-deficient reader). There is deliberately no purple in it: purple is
the accent, and a series must never read as "this is clickable". A notebook's own figure
colors (domino types, depth classes, grape varieties) are the notebook's, validated against
the surface they sit on, and are not this document's business beyond that rule.

No shadows, anywhere. No dark mode.

## Typography

**Faces, by fixed job:**

- **Fraunces** (display) — section titles (`h2`), the wordmark, the display-sub line. Its
  soft and wonky axes are on for these roles; discretionary ligatures on; never tracked
  (tracking suppresses the ligatures). Never body text, never numerals.
- **Cormorant Garamond** (reading) — page headings (`h1`), titles (`h3`), prose, nav item
  names, table cells, the standfirst. It sets small, so body runs one step larger than a
  sans scale would and carries weight 500; titles carry 700.
- **Libre Franklin** (labels) — only uppercase and wide-tracked: eyebrows, control labels,
  buttons, table headers, nav chrome, the TOC, the tool chrome's rows. Quiet and structural.
- **Georgia** (system) — every numeral (and `$` and `:`), everywhere outside code, reached
  through a digit-routing font face so the surrounding words keep their face.
- **System mono** — code, SQL, transcripts, error messages. Deliberately without code
  ligatures: a transcript must show the exact characters that were typed.

**The type scale.** Fluid `clamp()`; no media queries for size.

| Role | Face | Size | Treatment |
| --- | --- | --- | --- |
| display (wordmark) | Fraunces | `3 → 5.5rem` | 300, soft 100 |
| display-sub | Fraunces | `1.2 → 1.8rem` | ligatures, untracked |
| heading (`h1`) | Cormorant | `2 → 3rem` | 400 |
| subhead (`h2`) | Fraunces | `1.5 → 2rem` | ligatures, untracked, hairline to the margin |
| title (`h3`) | Cormorant | `1.2 → 1.4rem` | 700 |
| body | Cormorant | `1.15 → 1.3rem` | 500 upright, leading 1.45 |
| small | Cormorant | `1 → 1.1rem` | captions in the reading face, table cells |
| lede | Cormorant | `1.3 → 1.5rem` | 400, ink-muted, its own measure |
| label / eyebrow (`h4`) | Franklin | `0.7 → 0.8rem` | 0.18em, UPPERCASE |
| tagline | Franklin | `0.85 → 1.05rem` | 300, 0.25em, UPPERCASE |
| ui | Franklin | `0.85rem` | the tool chrome's running size |
| mono | system mono | `0.8rem` | code, log rows |

**The page-header stack.** Under a page heading, the summary paragraph is a **lede**: the
reading face, upright, ink-muted, on its own 44rem measure — a standfirst, not a label. The
display voices carry *lines*, never paragraphs: a tagline is one line of eight words or so,
and display-sub is a few words of voice. A page wanting both stacks them: eyebrow → heading
→ tagline → lede.

**Section titles finish their line.** An `h2` is followed by a hairline filling the rest of
its line. Section titles are short and lowercase in the notebooks (`theory`, not `The
Underlying Theory`) — the TOC rail is a map, not a syllabus.

## Spacing & layout

One ramp (0.25rem base): `3xs` (.25) · `2xs` (.5) · `xs` (.75) · `sm` (1) · `md` (1.5) ·
`lg` (2.5) · `xl` (4) · `2xl` (6) rem.

`--measure: 36rem` for prose, `--measure-lede: 44rem` for the standfirst, `--measure-wide:
52rem` for notebook prose that runs beside wide figures; `--page-max: 84rem` — a notebook
dashboard is wide, and prose stays on its measure inside it; `--nav-width: 15rem`;
`--radius: 0`, square by intent; hairlines are one pixel.

## Components — the aiui-viz anatomy

aiui-viz emits stable class names and leaves their look to the consumer. This system is one
such consumer. The roles above map onto that anatomy:

- **Cell states.** *Pending*: spinner and a label in the label voice, muted. *Loading*: the
  last value stays, dimmed, with a thin accent stripe along the top of the cell. *Error*: a
  mono message in brick on a brick wash, hairline border, square corners, an outline Retry.
- **Controls.** A control's label is an eyebrow; its live value is Georgia on the tabular
  rail (a unit keeps its case). Slider thumbs and checks take the accent. A select wears the
  eyebrow over a full-width field in the reading face.
- **The scrub pill.** A number that lives in the prose is a `ControlScrub`: a quiet caption
  and the value in bold tabular figures, inside a hairline **double dashed ring** — border
  plus offset outline — the standing "this drags" affordance. The one sanctioned pill,
  because it is an instrument, not a button. Hover and the drag take the accent.
- **The lens.** A term that opens into detail is a dotted underline in the muted ink, accent
  under the pointer. Its peek and detail panel are hairline surfaces on the page's own
  ground — square, unshadowed — the title in the label role, the page behind dimmed.
- **Live text.** A cell's value inside a sentence (`CellText`) is tabular and never breaks
  across a line; no chrome, no spinner — an ellipsis until the first value.
- **Buttons.** Franklin, tracked, uppercase; solid ink for the primary action, hairline
  outline for the rest; square. No pill shapes, no shadows.
- **Panels and tiles.** A panel is an instrument's surface: raised paper with a ghost edge —
  a sanctioned box, because its contents are controls and charts. A stat tile is a number
  over its label with a hairline above; it sits on the panel's ground, never in a box of its
  own.
- **Site chrome.** The nav sidebar and TOC are Franklin territory except item names, which
  are Cormorant (they are titles). Active states are an ink left rule, not a fill. The phone
  drawer slides over a scrim; desktop pins it.
- **Landing cards.** A plate (the live preview, hairline-framed) over a title, a blurb in the
  reading face, and an "open" eyebrow. No card box: the plate is the picture and the text
  sits on the paper under it.
- **Tables & figures.** Franklin uppercase headers over a hairline; cells in the reading
  face with tabular numerals; captions in the label role.
- **Mathematics.** KaTeX on the page's ink; display math on its own line with room to scroll.

## The tool chrome

The console, the intent panel, the trace debugger, the voice dock, the tool log, and the
widgets they host are instrument panels, not documents, so they run on the label voice and
the mono face at the `ui` and `mono` sizes, with the reading face reserved for the one place
a person reads sentences (a transcript, a prompt). Rules that keep them of a piece with the
pages:

- Same tokens, same ladder, same paper. A panel is raised paper with a hairline; a row is
  separated by a ghost rule, never striped.
- **Status is a dot.** A backend's state (live, connecting, parked, errored) is a small
  filled circle in ok, warn, accent, or alarm; the pill itself stays hairline. A toggle that
  is on is **inverted** (ink on paper becomes paper on ink), not tinted.
- Logs and transcripts: the caller in the label voice, the text in mono, timings on the
  tabular rail; a failed row's message in brick. Nothing else is colored.
- **Shipped widgets read hooks.** A widget that may land on *any* page (the dock, the tool
  log, the trace debugger, the slides deck, the oracle and live strips) reads prefixed
  `--aiui-*` tokens with its own neutral fallback, so it is of a piece here and inoffensive
  elsewhere. It never hard-codes this palette.

## Do / Don't

- **Do** map every text element to a role. **Don't** set fonts ad hoc.
- **Do** render numerals in Georgia — outside code. **Don't** route code digits.
- **Do** use the ladder. **Don't** invent grays or add a second accent.
- **Do** keep the accent on interaction. **Don't** use it for headings, decoration, emphasis,
  or a data series.
- **Do** use color, weight, and size for hierarchy. **Don't** add boxes, fills, shadows, or
  rounded corners. (Sanctioned boxes: panels, code blocks, error surfaces, the dropdown
  popover, the lens panel — hairline-bordered, square, unshadowed. Sanctioned round things:
  the scrub pill, the dock pills, status dots.)
- **Do** mount a simulation on a plate. **Don't** give one demo's plate a light variant.
- **Do** turn ligatures on for the display face. **Don't** track it.
- **Do** set summary paragraphs as ledes. **Don't** feed a tagline or display-sub more than a
  line.
- **Do** propose changes by editing this document first. The package follows, and the
  styleguide page is the check.
