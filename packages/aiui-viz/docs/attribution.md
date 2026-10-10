# Attribution: from a gesture to source

The whole workflow rests on one resolution problem: a human points at the running app — selects a
sentence, drags a rectangle, says "make *this* wider" — and the prompt that reaches the agent must
answer two different questions about whatever was pointed at:

1. **Which code *authored* this element?** A file, line, and column to open.
2. **Which computation *produced* this value?** A dataflow cell to reason about.

They are different questions (a `<span>` in a table is authored in `Table.tsx` but its number came
from the `analysis` cell defined in `graph.ts`), and everything on this page exists to answer both
mechanically. This is the concepts-level description. The page's half of the code lives in
`aiui-viz` (`CellView`, the cell registry, `page-selection.ts`, `registerStandardTools`) and in
the compiler (`aiui-source-processor`, the `aiui()` Vite plugin that stamps the DOM). The
capture half — the shot locator that resolves a dragged rectangle, the selection watcher an
extension runs in its isolated world, the prompt composition that renders what was found — is
a *host's* job: it was built in the intent tool that originally drove this contract, which now
lives outside this repo. The sections below describe the contract and the algorithms a host
follows against it; where they describe the former host's code, they describe it as history.

## The contract: three DOM attributes and a registry

Attribution is deliberately framework-neutral. The entire contract is data in the DOM:

| Attribute | Meaning | Emitted by |
| --- | --- | --- |
| `data-source-loc="src/ui/Controls.tsx:44:7"` | this element's **authoring site** (the JSX that wrote it), app-root-relative | the aiui compiler's JSX-stamping half, at compile time, serve and build alike (`stampJsx: false` opts a build out; the factory-identity half has no opt-out) |
| `data-cell="analysis"` | the **dataflow node** whose value is rendered inside this boundary | `CellView` and `CellText` (from the babel-injected cell name); a component rendering a cell's value *outside* them may declare it — the one manual attribute in the contract, and it is a *name*, so it cannot drift |
| `data-cell-loc="src/model/graph.ts:31"` | the cell's **definition site** — the `cell(…)` call itself | `CellView`, from the same injection |
| `data-control="kappa"` | the **control** this widget binds — the writable end of the surface | `ControlSlider`/`ControlToggle`/`ControlScrub`/`ControlSelect` (from the control's injected name); a hand-rolled binding declares it the same way — a name, never a location |

plus the live **cell registry** (`cellRegistry()` / the `cells` report section), which maps a
`data-cell` name to the cell's current state, definition site, and description at runtime — and
its writable twin, the **control surface** (`report` full: every control's value, constraints,
description, definition site, plus the control→cell dependency edges recorded live from each
cell's deps). A drag over a slider resolves to the control and its declaration exactly as a drag
over a chart resolves to the cell.

**Pixel→cell is supported by declaration only** — two paths with different economics, and no
third mechanism. (1) *The free path*: `CellView` stamps `data-cell`/`data-cell-loc` as a free
rider on the loading/error chrome the methodology mandates anyway — zero incremental cost, covers
the majority of cell renders. (2) *The declared path*: a render outside `CellView` declares
`data-cell="name"` — a name, not a location, so it cannot drift; a forgotten declaration is a
false negative only, because the element still carries its compiler-injected `data-source-loc`
and an agent is one file-read from identifying the cell itself. A runtime-internals mechanism
that derived stamps automatically was built, measured, and retired (the solid-cell-attribution
notes in git history carry the findings and the reasoning); compile-time
detection of cell reads in JSX was rejected because real components read cells non-lexically.
The division of labor: compile time owns *locations*, declarations own *identity*, runtime owns
*live state and topology*.

Two properties of this contract carry most of the weight:

- **Names are injected, not written.** The aiui Vite plugin
  (`aiui()` from `@habemus-papadum/aiui-source-processor`; the factory table is its
  `locator.factories` option) stamps JSX with `data-source-loc` and rewrites `cell(...)` /
  `control(...)` / `action(...)` call sites to carry their declaration name, location, and doc
  comment. Application code contains **zero** attribution affordances; delete the plugin and the
  app still runs, just unresolvable.
- **Never hand-write a location stamp.** `data-source-loc` and `data-cell-loc` are *compiler
  output*, full stop — do not type one into application code, and if you find one there, delete it
  and enable the plugin instead. A hand-written `file:line:col` is wrong the moment the file is
  next edited, and nothing can detect that it lies: the resolvers will hand the agent a confident,
  precise, incorrect location. This happened — an agent once hard-coded stamps into an app instead
  of using the plugin, and the resulting misresolutions cost real debugging time. (Unit tests may
  synthesize stamps to exercise the resolvers; nothing else should.) The one *legitimate* manual
  attributes are *names*: `data-cell="name"` for values rendered outside `CellView`, and
  `data-control="name"` on hand-rolled control bindings (the shipped widgets stamp it for you).

## Resolving a text selection

When the user selects on-page text, the resolution starts from the selection's **start element**
and walks outward — nearest stamped ancestor first:

- `closest("[data-source-loc]")` → the authoring site, and its stamped ancestors beyond it (the
  element chain: "which JSX authored this", at increasing levels of containment);
- the `data-cell` ancestors → the producing cells (the cell chain), each at its definition site
  through the same ladder the shot locator uses (next section): `data-cell-loc` first, the live
  registry, the element's own stamp, else the first stamped element *inside* the cell;
- `closest("[data-control]")` → the control the selection sits in.

The page does this itself: aiui-viz's `page-selection.ts` installs `window.__AIUI__.selection()`
and registers it as the `selection` standard tool, so an agent (the oracle, a live delegation, or
an external host calling the page's tools) asks the page what is selected and gets the text, the
TeX, both chains with
every location split into `file`/`line`/`col` — `file` exactly what the `source` tool takes — the
control, and optionally the client rects or the fragment rendered as Markdown. The page remembers
the last non-collapsed selection for two minutes, because focus moving into a textarea (the dock's
key field) empties the document's selection at exactly the moment a user presses a button; a read
answered from memory says `live: false`. A selection inside agent chrome (`data-aiui-chrome`) is
never one.

A host can read the same contract on its own — a browser extension's content script runs in an
isolated world and cannot see the page's global, so it walks the same stamps itself (the former
intent tool's extension tier did exactly that) — while a host that drives the page over CDP
simply asks the page. Either way the selection renders into the prompt inline, compact but
complete:

> Regarding the on-screen selection "3.2 eV" (authored at src/ui/Table.tsx:88:12; produced by cell
> analysis defined at src/model/graph.ts:31)

Long selections become a fenced block under the same attribution header. Selected mathematics adds
its TeX source (the `data-tex` stamp from the `TeX` component).

## Resolving a drag rectangle (the shot locator)

A region screenshot must name **what the user framed** — a point of reference, not an inventory.
The first implementation grid-sampled `elementsFromPoint` over the rect and reported every
annotated ancestor it touched, which put the app shell in every single shot (any rect intersects
it). The strategy that replaced it — the intent tool's `locateComponents`, retired from this repo
with that tool, and the intended reading of the contract for any host resolving a rectangle:

1. **Enclosure.** Keep the annotated elements *fully inside* the rect (±2px tolerance), then drop
   any that another kept element contains. The survivors — the highest enclosed elements — are
   what the drag deliberately framed. A drag around the whole dashboard legitimately yields
   several panels; a drag around one chart yields that chart.
2. **The `within` fallback.** If the rect encloses nothing annotated — a drag *inside* one big
   canvas — resolve instead to the **innermost annotated element containing** the rect, marked
   `containment="within"`: one element, the smallest true answer to "where is this?".
3. **The cell frontier.** For each kept element, list its **direct** `data-cell` descendants —
   the topmost cells with no other cell between them and the element. One level deep on purpose:
   cells mirror the dataflow graph, and frontier names are enough for an agent to enter it via
   the registry; enumerating the whole subtree would bury the reference points.
4. **The naming ladder.** Each element is named by the best identity available:
   its `data-cell` name → the **authoring module** read off its source stamp
   (`src/ui/Controls.tsx:44:7` → `Controls`) → the bare tag as last resort. The middle rung is a
   paid-for fix: without it, a drag across a dashboard rendered as `name="div"` repeated per
   panel — noise in the prompt and in the captions of the trace debugger that reviewed it —
   while the informative name sat right there in the stamp.
5. **The cell-source ladder** (shared by the shot locator, the selection watcher, and the jump
   picker — one implementation, `cellSourceLoc`). A frontier cell's `source` is its
   `data-cell-loc` (definition site) when stamped; else the **live cell registry** — aiui-viz
   mirrors `name → definition site` at `window.__aiuiCells`, which is what makes the one manual
   `data-cell="name"` attribute resolve to the full `cell(...)` definition line; else the
   element's own JSX stamp; else the first stamped element *inside* the cell — where its UI is
   authored, an approximation, but the right file to open first.

Full-viewport shots skip the locator entirely: "everything" frames nothing, and element
metadata without a reference point is bulk.

Stamps are app-root-relative; when the page knows its `sourceRoot` (`window.__AIUI__.sourceRoot`)
they're resolved to absolute paths on the spot, otherwise the host resolves them when it composes
the prompt.

## What the agent actually receives

The structured record carries **everything** the locator found — rendering decisions happen when
the prompt is composed, never at capture time (the defer-rendering rule: inputs travel
structured; formatting is the composer's decision). The prompt the former intent tool composed
inlined each shot at its position in the prose, and the shape is the one any host should keep:

```xml
[screenshot located at ~/.cache/aiui/projects/app-1a2b3c4d/traces/…/shot_1.png]
<screenshot-metadata path="~/.cache/aiui/projects/app-1a2b3c4d/traces/…/shot_1.png">
  <element name="SimCanvas" source="src/ui/SimCanvas.tsx:64:10"/>
  <element name="AnalysisPanel" source="src/ui/AnalysisPanel.tsx:99:5">
    <cell name="analysis" source="src/model/graph.ts:31"/>
  </element>
</screenshot-metadata>
```

The image reference is a plain-text bracket line; the XML block carries the located-element
metadata and appears only when elements were located. (Every render path — shots, selections,
boundaries, the preamble — was cataloged with real outputs in the former channel package's
`prompt-vocabulary.md`, retired to git history with it.) Every path — the image and each source —
is relativized against the agent's working directory. Two render-time caps keep a big drag from
flooding the prompt while the structured record stays complete: at most **8 elements** per shot
(`elements-omitted="N"` says what was dropped) and at most **4 cells** per element
(`cells-omitted="N"`). A `within` anchor renders as `containment="within"` so the agent knows
it's context, not framing.

A host's transcript preview can show the same resolution in miniature — the former trace
debugger captioned each screenshot with the first few element names — so a caption reading
`shot_1 · SimCanvas, Controls, TimeSeries +2` is a one-glance check that resolution worked, and a
caption full of bare tags means the page isn't stamped (the plugin's `locator` option is missing,
or the elements carry no annotations).

## Resolving from the agent's side

The same contract serves the reverse direction. `registerStandardTools` gives every app a
`locate` tool — CSS selector in, the nearest `data-source-loc` / `data-cell` stamps out — and the
`report` tool (full format: every control with meta and loc, every named cell with state,
description, and definition site, the dependency edges, and each registered action). An
agent that received `<cell name="analysis" …/>` in a prompt can go from the name to the live
cell's state without any further wiring. An editor integration's jump-to-source rides the same
stamps (the former VS Code extension's jump mode did).

## The call log

Attribution answers "which code made this?"; the call log answers the other question an
agent-driven app raises — **"was my agent actually calling the tools?"** The page's registry
(`window.__AIUI__.tools`) records every tool call it routes: who called (`oracle`,
`live:<delegator>`, `page` for the app itself, and whatever name an external host sends —
`channel` was the former MCP channel host's, `panel` its intent panel's), with what, how long it
took, and the result or error, clipped to 4 KB and kept to the last 200. `calls()` reads it; `onCall` follows it; a projection that executes a
control's setter directly (the oracle's control-surface tools) reports through `record` so the
log stays complete.

The on-page viewer is `ToolLog` (`@habemus-papadum/aiui-viz/site/tool-log`, its own subpath):
mount it once, hidden by default, opened by `#aiui-tools` in the URL or `toggleToolLog()`. Its
third view, *as rendered*, shows what a model sees — the `Tools:` section every consumer
renders from the same document, and the structured form the registry's `list()` returns (what an
external host forwards as its tool listing).

## Where this can drift

The resolution is only as good as the stamps. The failure modes, in the order you'll meet them:

- **No stamps at all** — the `aiui()` plugin is missing from
  `vite.config.ts`. Everything degrades to tags and `source="unknown"`.
- **Cells without `data-cell`** — values rendered outside `CellView` need the one manual
  attribute (`data-cell="name"`) to join the contract.
- **A hand-written location stamp** — a hard-coded `data-source-loc`/`data-cell-loc` that no
  longer matches the file. The resolvers cannot detect the lie. This is not a supported
  configuration to maintain: delete the stamp and enable the plugin.
