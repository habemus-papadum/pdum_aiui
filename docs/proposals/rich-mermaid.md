# Rich Mermaid: a diagram as a control surface

Status: spike, 2026-10-16. The component landed as `@habemus-papadum/aiui-viz/site/mermaid`
(`packages/aiui-viz/src/site/mermaid.tsx`) with two lab pages (`pnpm -C packages/aiui-viz lab`,
then `/pipeline` and `/anatomy`). No demo notebook uses it yet. This document records what
Mermaid 12.2 was measured to provide, the design that follows from it, and what was rejected.

## The question

RichTeX made an equation's pieces addressable after KaTeX drew them: styled, hovered, clicked,
annotated, reactive. The ask was the same for Mermaid, with one sharper target: the simplest
flow in which a diagram is drawn from a string and then DRIVES the UI through clicks and drags
on its nodes and links, without a ball of complexity. Two questions decide the design: how far
can the string be correlated with the rendered elements, and can decoration be kept off the
expensive render path.

## The answer

Mermaid is an easier case than TeX, for one reason: **identity is in the syntax**. `A[Start]`
names the node `A`; `feat e1@--> train` names the edge `e1` (an unnamed edge is `L_A_B_0`:
source, target, ordinal); `subgraph S` names the cluster. Mermaid writes those ids into the SVG
it returns. RichTeX had to inject `\htmlData` markers at assembly time to manufacture identity;
here the map from the author's ids to elements is simply recovered from the markup the author
already caused. No marker injection, no second parse, no descriptor children.

So the component is small (one file, ~750 lines, a third of them its doc) and does five things:

1. **Render** the text through `mermaid.render` — async, serialized inside Mermaid, latest-wins
   here (a result for a superseded text is dropped), the previous drawing kept on screen until
   the next is ready, a parse error shown beside the last good drawing.
2. **Index** the result: every `g.node`, `path[data-edge]`, `g.cluster` (and, in sequence
   diagrams, every `[data-et][data-id]`) is stamped `data-aiui-id` / `data-aiui-kind` from the
   id Mermaid wrote; a transparent 12 px clone is laid under each edge so a 1 px line is
   clickable.
3. **Delegate** pointer events on the host (the SVG is replaced per render, the host is not):
   `onClick(hit)` / `onHover(hit)` with `{ kind, id, el }`.
4. **Apply marks** keyed by id — `color`, `fill`, `class`, `active`, a `note` (JSX in an
   overlay anchored to the element's box), a `control` (drag sideways to scrub it, arrow keys
   when focused, `data-control` + ARIA like every control widget) — as attributes and inline
   style. Nothing re-renders.
5. **Stamp** the agent surface: `data-mermaid` on the root with the source text (the best
   representation of a diagram for an agent is the text), the per-element ids above, a knob's
   `data-control`.

Two reactive levels, as in RichTeX: a text change costs a layout (30 ms for a handful of
nodes, 150 ms for forty, 700 ms for 120 — unavoidable; it IS the render); a mark change costs
attribute writes, so CSS transitions run. Mermaid's own `style`/`classDef` directives are the
wrong lever for state: they live in the text (a full re-render per change) and land as
`!important` rules.

**Where this stops, and `aiui-svg` starts.** Mermaid is a text-first, auto-laid-out VIEW of a
model: the app writes a string from its pure model, Mermaid decides the geometry, the user
selects, hovers, annotates and scrubs. A node drag here is a gesture on a value (a knob), not a
move: Mermaid has no interactive layout, and repositioning means rewriting the text and letting
dagre decide again. When the geometry is the document — placing a component, dragging it,
editing a connection, undo — that is the [semantic SVG direction](./semantic-svg.md), not
Mermaid wearing a costume. The two compose: a Mermaid flow for the process view, an SVG
document for the thing being edited.

## What Mermaid 12.2 provides — measured

Measured in headless Chromium against `mermaid@12.2.0` (released 2026-10-13); the probe scripts
were throwaway, the facts are pinned by `mermaid.test.tsx` (over a fake that writes the same
markup shape) and by the lab's `/anatomy` page (over the real thing).

**Identity in the markup**

| Diagram | Node | Edge | Cluster |
|---|---|---|---|
| flowchart | `g.node#<svg>-flowchart-<id>-<n>` | `path[data-edge][data-id="L_A_B_0"]` or the user's `e1@-->` id; label `g.label[data-id]` | `g.cluster#<svg>-<id>` |
| stateDiagram-v2 | `#<svg>-state-<id>-<n>` | `data-id="edge<n>"` | `g.cluster[data-id]` |
| classDiagram | `#<svg>-classId-<id>-<n>` | `data-id="id_A_B_<n>"` | — |
| erDiagram | `#<svg>-entity-<id>-<n>` | `data-id="id_entity-A-0_entity-B-1_0"` | — |
| sequenceDiagram | `[data-et="participant"][data-id]`, `[data-et="note"]` | `line[data-et="message"][data-id="i<n>"]` | — |
| mindmap | `#<svg>-node_<n>` (Mermaid's own ids) | `data-id="edge_<a>_<b>"` | — |
| timeline, gantt, pie … | none | none | — |

The node-id rule is `<svgId>-<diagram word>-<id>-<counter>`, where the diagram word has no dash
and the id may (`flowchart-a-b-0` → `a-b`; `flowchart-step-2-4` → `step-2`); a cluster is
`<svgId>-<id>`; a `data-id` wins when present (`recoverId` in the component). The counter is
deterministic for a given text (it counts vertex mentions), the markup is byte-identical
across renders modulo the svg id, and `deterministicIds` changes nothing we rely on. Every
edge also carries `data-points` — its polyline, base64 JSON — and the DOM gives boxes
(`getBoundingClientRect`, `getBBox`) and path geometry (`getPointAtLength`), so no layout
hook is needed for geometry.

The structured model is available too: `mermaid.mermaidAPI.getDiagramFromText(text)` →
`db.getData()` yields nodes (`id`, `domId`, `label`, `shape`, `parentId`, `cssClasses`) and
edges (`id`, `start`, `end`, `label`) before layout, for 1.5 ms (small) to 18 ms (120 nodes).
The component does not need it (the markup suffices) and an app that generated the text has
the model already; it is there for a future "list the diagram" tool. Beware: some dbs' domId
counters are global across parses (state diagrams), so a domId from a separate parse may not
match the render — another reason to recover ids from the markup.

**Labels** are HTML (`foreignObject > div > span.nodeLabel > p`) under the default
`htmlLabels`, sanitized by DOMPurify at the default `securityLevel: "strict"`: `<span class
data-*>` and `<b>` survive, `onclick`/`<script>` do not; markdown strings (`"`**bold**`"`)
work. That is KaTeX's `\htmlData` analog, available if a label ever needs a hook of its own —
unused, because nodes already have ids. `pointer` events on the `<p>` reach the node's `<g>`
through `closest()` (the foreignObject is in the same tree).

**The render API**

- `render(id, text, container)` returns `{ svg, bindFunctions }` as a string; calls serialize.
- The id must be FRESH per render: Mermaid first removes any element with that id from the
  document, so reusing the displayed svg's id blanks the host while the new one lays out.
- The `container` is where Mermaid's temporary div goes and where labels are measured. Passed
  an element inside the host, `fontFamily: "inherit"` measures with the host's font and labels
  fit; measured in the body, a monospace host overflowed its boxes.
- A parse error rejects with the message; without `suppressErrorRendering: true` it also leaves
  `div#d<id>` in the body. `parse(text, { suppressErrors: true })` returns `false` for an
  invalid or unknown diagram.
- Mermaid's `click A call cb()` directive needs `securityLevel: "loose"` and `bindFunctions`;
  `click A href` wraps the node in `<a>` in strict mode too. Neither is used: one delegated
  listener on the host covers everything, and strict stays strict.

**Cost** (headless Chromium, M-series laptop; median of several)

| text | render |
|---|---|
| 5 nodes, 6 edges, 1 subgraph | 29 ms |
| the same with a `style` directive changed | 27 ms (a full render) |
| 40 nodes, 80 edges | 142 ms (dagre); 124 ms (elk) |
| 120 nodes, 240 edges | 728 ms |

`htmlLabels: false` is not faster. Parse alone is 1.5–18 ms. `innerHTML` of a 40-node result is
negligible against the render.

**Styling.** The returned svg carries a `<style>` scoped by its id (`#p1 .node rect {…}`, ~5 kB),
which outranks any class rule a page writes; `classDef` and `style` directives add `!important`.
`theme: "null"` still emits the full default sheet. The base theme with `themeVariables` is the
working lever (`primaryColor`, `primaryBorderColor`, `lineColor`, `fontFamily`, cluster and label
backgrounds all land where expected). The component additionally rewrites the sheet's `#id` to
`:where(#id)` after each render — zero specificity, same scoping — so a consumer's ordinary
selectors win without `!important` (the lab's `mermaid.css` has none).

**Mermaid 12 defaults** (12.0.0, 2026-09-10): ELK is bundled and the default layout for
flowchart/state/class/er; `neo` is the default look (gradient borders, a 120 px minimum label
width — `flowchart.minNodeWidth: 0` for tight nodes), `redux-color` the default theme; targets
ES2024 / Safari 17.4 / Node 22.12. The lab sets `look: "classic"`, `layout: "dagre"`, the base
theme with the design tokens. Per-diagram config works as YAML frontmatter (`---\nconfig:
{…}\n---`; JSON is YAML), which is how the component's `config` prop travels. The package's
`exports` point at `mermaid.core.mjs` (56 kB) plus its dependencies (d3, dagre, elk, cytoscape,
katex, dompurify, …): large, so the component loads it with `import("mermaid")` on first use
and lives on its own subpath, off the `/site` barrel.

## The design, in the component's terms

```tsx
<Mermaid
  text={pipelineText(params())}             // the pure model's string; a change re-renders
  config={{ flowchart: { curve: "basis" } }} // per-diagram frontmatter (site defaults: configureMermaid)
  marks={{
    train: { fill: wash, color: ink, active: sel() === "train", note: <Chip id="train" />, control: epochs },
    e_feat_train: { color: accent, class: "flowing" },
  }}
  onClick={(hit) => hit.kind === "node" && select(hit.id)}
  onHover={setHover}
  onRender={({ ids, ms }) => …}             // what became addressable, at what cost
/>
```

Conventions the lab settled on:

- **The text is a function of the pure model** (`pipelineText(params)`), never assembled in a
  component. Name the edges the app will address (`feat e_feat_train@--> train`); quote labels.
- **Structure and decoration are different signals.** The lab keys the text on the one switch
  that changes the drawing (`withEval`) and everything else on marks, so a knob drag or a
  clock tick never re-renders. Node marks and edge marks are separate memos, so a hover (edges
  only) leaves the node mark objects — and their note DOM — untouched; the component keys
  notes on the mark object, not on the pass.
- **State looks are CSS on the component's attributes** (`[data-active]`, `[data-hover]`,
  `[data-scrubbing]`, the mark's `class`), transitions included; the palette is
  `themeVariables` from the design tokens (`lab/src/ui/mermaid-theme.ts`).

**Rejected, and why**

- RichTeX-style descriptor children (`<Node id>` inside `<Mermaid>`): identity already exists;
  a keyed `marks` map is the whole API, and the diagram stays one string from one function.
- Mermaid's `click` directive / `bindFunctions`: per-element binding, loose security level,
  nothing a delegated listener does not do better.
- State through `style` / `classDef` in the text: a layout per change, `!important` on landing.
- Morphing the SVG across renders (keeping node elements alive, FLIP by id): tempting for
  animated relayout, not needed for a control surface, and it would own Mermaid's DOM. Noted
  as a follow-on; today positions jump when the text changes.
- A custom layout loader (`registerLayoutLoaders`) to capture geometry: internal API, and the
  DOM already carries `data-points` and boxes.
- A second parse (`getDiagramFromText`) to build the id map: the markup is exact and the
  domId counters of some dbs are not stable across parses.
- `theme: "null"` to skin everything from CSS: still emits a sheet; `:where()` taming plus
  theme variables is the working pair.

## Limits worth knowing

- Re-render = new SVG: no transitions across layouts; marks come back by id, geometry does not.
- A knob is a horizontal drag on a value. Mermaid cannot move nodes; "drag to reposition" is
  the semantic SVG proposal's territory.
- Arrowheads are shared `<marker>`s: a mark's `color` recolors the line, not its head.
- Notes anchor to measured boxes (after render, resize, font load); no collision pass yet
  (RichTeX has `resolveNoteShifts` to borrow).
- Keyboard: knobs are focusable and answer the arrows; a merely clickable node has no keyboard
  path (the same open item as RichTeX terms).
- Coverage: flowchart, state, class, ER fully addressable; sequence via `data-id`/`data-et`;
  mindmap by Mermaid's own node ids; timeline/gantt/pie render with no handles.
- The unit test runs over a fake Mermaid (jsdom has no layout). The real markup shape is
  pinned only by the lab; a Playwright test in the pencil style would make it CI's business.

## What the lab shows

- `/pipeline` — a build pipeline (`raw → clean → featurize → train → evaluate → ship? →
  deploy`, a subgraph, a feedback edge). Click a stage: selected, its details open, its edges
  light; click an edge: its target is selected. Run the clock: stages turn done/active/pending
  by fill, the active one breathes, edges whose source is done carry a marching dash, a chip
  under each stage shows rows or progress. Drag `train` sideways: it is a knob on `epochs`
  (`data-control`, ARIA, arrow keys). Toggle the evaluate stage: the text changes, Mermaid
  re-lays, every mark returns by id. Agent surface: `select-stage`, `reset-run`, the controls.
- `/anatomy` — any source (flowchart / state / sequence / class presets, editable), rendered,
  with the recovered ids by kind, the render cost, what is under the pointer, a toggle that
  shows the edge hit areas; break a line and the last drawing stays with the parse error
  beside it; click an element to pin a note on it.

## If adopted — follow-ons, in order of value

1. A `.aiui-mmd` skin in `aiui-design/site.css` (now possible with ordinary selectors) and the
   theme-variable map as a `mermaidTheme()` accessor beside `plotStyle()`.
2. `read-page` / `selection` awareness of `data-mermaid`, as for `data-tex`: emit the source
   where a diagram sits in the page text; resolve a selection inside one to its id.
3. The knob helpers shared with RichTeX (`formatKnob`, `perPxOf`, `keyStepOf`) into one module.
4. A Playwright test over the real Mermaid pinning the markup facts above.
5. Keyboard access for clickable nodes; a note collision pass.
6. FLIP transitions across re-renders keyed by id, if a demo wants animated relayout.

The lab became the uniform aiui-viz lab with this spike (scope `viz-lab`; shared `lab-`
chrome, `rtx-lab-` for the RichTeX pages, `mmd-lab-` for the Mermaid pages), the place the
SVG work is meant to join.
