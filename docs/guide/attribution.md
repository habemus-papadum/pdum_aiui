# Attribution: from a gesture to source

The whole workflow rests on one resolution problem: a human points at the running app — selects a
sentence, drags a rectangle, says "make *this* wider" — and the prompt that reaches the agent must
answer two different questions about whatever was pointed at:

1. **Which code *authored* this element?** A file, line, and column to open.
2. **Which computation *produced* this value?** A dataflow cell to reason about.

They are different questions (a `<span>` in a table is authored in `Table.tsx` but its number came
from the `analysis` cell defined in `graph.ts`), and everything on this page exists to answer both
mechanically. This is the concepts-level description; the code lives in the dev overlay
(`source-locator.ts`, `selection.ts`, `multimodal/shot.ts`, `multimodal/vscode.ts`,
`intent-pipeline/engine.ts`) and in `aiui-viz` (`CellView`, the cell registry,
`registerStandardTools`).

## The contract: three DOM attributes and a registry

Attribution is deliberately framework-neutral. The entire contract is data in the DOM:

| Attribute | Meaning | Emitted by |
| --- | --- | --- |
| `data-source-loc="src/ui/Controls.tsx:44:7"` | this element's **authoring site** (the JSX that wrote it), app-root-relative | the aiui compiler's JSX-stamping half, at compile time, dev-only (its factory-identity half runs in production builds too) |
| `data-cell="analysis"` | the **dataflow node** whose value is rendered inside this boundary | `CellView` (from the babel-injected cell name); a component rendering a cell's value *outside* CellView may declare it — the one manual attribute in the contract, and it is a *name*, so it cannot drift |
| `data-cell-loc="src/model/graph.ts:31"` | the cell's **definition site** — the `cell(…)` call itself | `CellView`, from the same injection |
| `data-control="kappa"` | the **control** this widget binds — the writable end of the surface | `ControlSlider`/`ControlToggle` (from the control's injected name); a hand-rolled binding declares it the same way — a name, never a location |

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
that derived stamps automatically was built, measured, and retired (see the retired proposal
`docs/proposals/solid-cell-attribution.md` for the findings and the reasoning); compile-time
detection of cell reads in JSX was rejected because real components read cells non-lexically.
The division of labor: compile time owns *locations*, declarations own *identity*, runtime owns
*live state and topology*.

Two properties of this contract carry most of the weight:

- **Names are injected, not written.** The overlay's Vite plugin
  (`aiui({ locator: { cellFactories: ["cell"] } })`) stamps JSX with `data-source-loc`
  and rewrites `cell(...)` call sites to carry their declaration name and location. Application
  code contains **zero** attribution affordances; delete the plugin and the app still runs, just
  unresolvable.
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

When the user selects on-page text (before or during a turn), `selection.ts` resolves from the
selection's **start element** with `closest()` — nearest stamped ancestor wins:

- `closest("[data-source-loc]")` → the authoring site;
- `closest("[data-cell]")` → the producing cell, and for its definition site the same ladder the
  shot locator uses (next section): `data-cell-loc` first, else the first stamped element *inside*
  the cell as an approximation.

It renders into the prompt inline, compact but complete:

> Regarding the on-screen selection "3.2 eV" (authored at src/ui/Table.tsx:88:12; produced by cell
> analysis defined at src/model/graph.ts:31)

Long selections become a fenced block under the same attribution header. Selected mathematics adds
its TeX source (the `data-tex` stamp from the `TeX` component).

## Resolving a drag rectangle (the shot locator)

A region screenshot must name **what the user framed** — a point of reference, not an inventory.
The first implementation grid-sampled `elementsFromPoint` over the rect and reported every
annotated ancestor it touched, which put the app shell in every single shot (any rect intersects
it). The current strategy, in `locateComponents`:

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
   panel — noise in the prompt and in the trace viewer's captions — while the informative name
   sat right there in the stamp.
5. **The cell-source ladder** (shared by the shot locator, the selection watcher, and the jump
   picker — one implementation, `cellSourceLoc`). A frontier cell's `source` is its
   `data-cell-loc` (definition site) when stamped; else the **live cell registry** — aiui-viz
   mirrors `name → definition site` at `window.__aiuiCells`, which is what makes the one manual
   `data-cell="name"` attribute resolve to the full `cell(...)` definition line; else the
   element's own JSX stamp; else the first stamped element *inside* the cell — where its UI is
   authored, an approximation, but the right file to open first.

Full-viewport shots (`S`) skip the locator entirely: "everything" frames nothing, and element
metadata without a reference point is bulk.

Stamps are app-root-relative; when the page knows its `sourceRoot` (`window.__AIUI__.sourceRoot`)
they're resolved to absolute paths on the spot, otherwise the channel resolves them at compose
time.

## What the agent actually receives

The structured intent carries **everything** the locator found — rendering decisions happen at
lowering time, never at capture time (the repo's defer-rendering rule). The composed prompt then
inlines each shot at its position in the prose:

```xml
[screenshot located at .aiui-cache/traces/…/shot_1.png]
<screenshot-metadata path=".aiui-cache/traces/…/shot_1.png">
  <element name="SimCanvas" source="src/ui/SimCanvas.tsx:64:10"/>
  <element name="AnalysisPanel" source="src/ui/AnalysisPanel.tsx:99:5">
    <cell name="analysis" source="src/model/graph.ts:31"/>
  </element>
</screenshot-metadata>
```

The image reference is a plain-text bracket line; the XML block carries the located-element
metadata and appears only when elements were located. Every path — the image and each source —
is relativized against the agent's working directory. Two render-time caps keep a big drag from
flooding the prompt while the structured record stays complete: at most **8 elements** per shot
(`elements-omitted="N"` says what was dropped) and at most **4 cells** per element
(`cells-omitted="N"`). A `within` anchor renders as `containment="within"` so the agent knows
it's context, not framing.

The debug UI's transcript preview shows the same resolution in miniature — each screenshot's
caption lists the first few element names — so a caption reading `shot_1 · SimCanvas, Controls,
TimeSeries +2` is your one-glance check that resolution worked, and a caption full of bare tags
means the page isn't stamped (the plugin's `locator` option is missing, or the elements carry no
annotations).

## Resolving from the agent's side

The same contract serves the reverse direction. `registerStandardTools` gives every app a
`locate` tool — CSS selector in, the nearest `data-source-loc` / `data-cell` stamps out — and the
`report` tool (full format: every control with meta and loc, every named cell with state,
description, and definition site, the dependency edges, and each registered action). An
agent that received `<cell name="analysis" …/>` in a prompt can go from the name to the live
cell's state without any further wiring. The VS Code extension's jump mode rides the same stamps.

## Where this can drift

The resolution is only as good as the stamps. The failure modes, in the order you'll meet them:

- **No stamps at all** — the `aiui()` plugin is missing from
  `vite.config.ts`. Everything degrades to tags and `source="unknown"`.
- **Cells without `data-cell`** — values rendered outside `CellView` need the one manual
  attribute (`data-cell="name"`) to join the contract.
- **A hand-written location stamp** — a hard-coded `data-source-loc`/`data-cell-loc` that no
  longer matches the file. The resolvers cannot detect the lie. This is not a supported
  configuration to maintain: delete the stamp and enable the plugin.
