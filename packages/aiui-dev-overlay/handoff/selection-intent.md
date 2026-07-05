# Handoff: selection → intent ("edit *this* text")

> **STATUS (2026-07-05): implemented — watcher/chip in aiui-dev-overlay
> (selection.ts, intent.ts); augmentation in channel processors.ts.**

For the overlay team, from the morphogen/demo session (2026-07-05). The question Nehal posed:
a user highlights something on the page — prose, a value, a rendered equation — and tells the
intent tool "change this to say …". The overlay needs the selected content, its geometry (for
screenshot annotation), and the same component/cell attribution the screenshot pipeline uses.
Three options were on the table: (1) the DevTools extension provides the mechanism, (2) no
extension at all, (3) frontend apps are instrumented with selection machinery.

**Recommendation up front: option 2. The extension is not needed, and neither is any new
app-side instrumentation.** The Selection API gives page-level code — i.e. the overlay runtime,
which is already injected into every page — everything required, and the attribution contract
the apps already carry (`data-source-loc`, `data-cell`, now `data-tex`) makes it precise. The
findings below were **verified empirically today** in the live demo, not reasoned from docs.

## What the browser actually gives page code (probed)

From plain page JS (`window.getSelection()`), for a selection over app prose:

- `selection.toString()` → the selected text.
- `range.startContainer.parentElement.closest("[data-source-loc]")` → `src/ui/App.tsx:32:9` —
  the exact authoring line, via **the same `closest()` logic the `locate` tool and the
  screenshot-annotation pipeline use**. `closest("[data-cell]")` likewise attributes to the
  dataflow node. Nothing new: selection is just a third consumer of the existing DOM contract.
- `range.getClientRects()` → precise per-line highlight rectangles (viewport coordinates) —
  exactly what screenshot annotation wants; also enough to render a confirmation highlight.

So the "browser won't make this easy" worry is unfounded **except for one real trap, also
verified**: the moment focus moves into the intent widget's textarea, the document selection
reads as empty (`toString() === ""`). Selections do not survive the very interaction that asks
about them.

**The fix is the standard one** (every "comment on selection" UI does this): the overlay keeps a
**selection watcher** — a debounced `document.selectionchange` listener that snapshots the last
non-collapsed selection: `{ text, rects, sourceLoc, cell, tex?, capturedAt }`. Verified:
`selectionchange` fires reliably around the focus transition, so the snapshot is always current
when the widget opens. The widget then shows the snapshot as an attached **chip** ("about:
'reaction-diffusion on the GPU' · App.tsx:32 ✕") that the user can keep or dismiss.

## Equations

Selected math is DOM soup (`toString()` of a KaTeX render is garbled). Two recovery layers:

1. **`data-tex` on the Math component wrapper** — the demo's `Math.tsx` stamps the raw TeX it
   rendered (requested from the component build; one attribute, zero app-author cost). The
   watcher's enrichment step: if the selection intersects a `[data-tex]` element, attach the TeX
   source to the snapshot.
2. Fallback for non-aiui KaTeX pages: KaTeX's default output embeds
   `<annotation encoding="application/x-tex">` (the original TeX) in its MathML — readable via
   `closest(".katex")?.querySelector('annotation[encoding="application/x-tex"]')`.

The lowered prompt then carries `\partial u/\partial t = …`, not mangled glyphs.

## Why the other options lose

- **Option 1 (extension-mediated):** the extension's unique powers are tab identity and
  `chrome.debugger` — process-level facts a page can't know. Selection is entirely page-level;
  routing it through the extension adds a dependency (not everyone has it) for zero information
  gain. Keep the extension out of this feature.
- **Option 3 (app-side machinery):** the burden Nehal worried about doesn't materialize, because
  the instrumentation already exists at the *library/compile-time* layer: the babel plugin stamps
  `data-source-loc`, `CellView` stamps `data-cell`, `Math` stamps `data-tex`. App authors (human
  or agent) write nothing selection-specific — the same "components are the instrumentation"
  principle that made cell attribution zero-affordance. Apps without any aiui instrumentation
  still degrade gracefully (tier table below).

## Suggested design (yours to shape)

- **Watcher** in the overlay runtime: debounced `selectionchange`; keep the last non-collapsed
  snapshot; invalidate on navigation and after a sanity TTL (~2 min) or when the snapshot's
  range no longer matches the DOM (`range.toString()` re-check). Ignore selections inside the
  overlay's own shadow root.
- **Affordance**: start with the chip inside the intent panel (appears whenever a snapshot
  exists — cheap, discoverable, dismissible). A floating "ask about this" popover near the
  selection is a nice later layer, not the MVP.
- **Payload**: a per-thread structured block in the modality payload (unlike tab identity, a
  selection is per-submission, not per-connection):
  `{ kind: "selection", text, tex?, sourceLoc?, cell?, rects, url }`. The channel's lowering
  augments exactly like the tab block: *"The user selected the following on screen (authored at
  src/ui/App.tsx:32, produced by cell 'catalog'): '…'. Their request follows."* Same
  degradation philosophy: every field optional.
- **Attribution tiers** (all verified paths):

  | App | Snapshot contains |
  | --- | --- |
  | any page | text + rects + a tag/class breadcrumb |
  | aiui-instrumented | + `sourceLoc` (file:line:col) + `cell` |
  | using the Math component | + `tex` |

- **Shadow DOM caveat** (for the docs, not the MVP): selections inside *app-side* open shadow
  roots need `Selection.getComposedRanges({ shadowRoots })` (standardized; Chrome ships it) —
  the aiui reference apps don't use shadow DOM, so plain `getSelection()` covers them. The
  overlay widget's own shadow root is irrelevant (we never attribute selections into it).
- **Multi-range selections** (Firefox Ctrl-select) — take range 0, note the limitation.

## Relationship to the other handoffs

This rides everything already specified: the attribution contract from
`source-locator-and-cell-attribution.md` (unchanged — selection is a new consumer), and the
lowering/augmentation shape from the tab-identity work (`frontend-tool-registry.md` is adjacent
but unaffected). No frontend API changes are required beyond the one-attribute `data-tex` stamp
already requested of the Math component.
