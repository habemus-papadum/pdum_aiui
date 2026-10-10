# Record inspector

The inspector accepts a stored semantic record or its JSON encoding. It validates the schema,
fingerprint, compiler version, and recorded decisions through the public core API, then recompiles.
There are no retained author closures, saved display strings, model calls, or imports from the spikes.
Loading is transactional: malformed JSON or an unsupported record displays a diagnostic and keeps
the previous validated view and fold state. The diagnostic explicitly names that retained state;
invalid input never becomes the record used for copying, downloading, or consumer lowering.

```ts
import { mountInspector } from "@habemus-papadum/aiui-prompts/inspector";
import "@habemus-papadum/aiui-prompts/inspector/style.css";
import "katex/dist/katex.min.css";

const view = mountInspector(element, savedRecord, {
  resolveAsset: asset => previewUrls.get(asset.id),
  copy: text => navigator.clipboard.writeText(text),
  onSource: origin => hostEditor.open(origin),
});

view.controller.select(occurrenceId);
view.controller.toggleFold(occurrenceId);
view.load(anotherRecord);
view.dispose();
```

The callback examples describe host-owned integrations. Rich preview renders declared images inline,
in their position among the text parts, with browser-native lazy loading. Raw output retains an image
marker with a hover/pinned popup. Clicking an inline image selects its atomic owner; folding that owner
hides the image in both panes. Missing URLs, resolver exceptions, and load failures remain visible.
The inspector does not fetch stored file paths. Source callbacks receive recorded
origins unchanged. An absent source is shown as absent. Placement and definition origins are shown
separately when both were recorded and differ. Additional transparent source boundaries are shown
from the occurrence's complete origin lineage, with one callback per distinct canonical JSON origin;
reordered object keys never create duplicate source destinations.
Contribution origins expose captured tool projection fields through the same callback, retaining
their tool snapshot fingerprint and field address.

Inline asset resolution is cached per output part for the current compilation, so selection and
folding do not repeatedly call the host resolver. Loading/recompiling a record refreshes that cache.
Raw popups resolve on opening. Hosts retain ownership of resolved URLs and their lifetime; preview
URLs never become part of the semantic record or affect the prepared delivery binding.

The base stylesheet is optional and neutral. Its inherited `--prompt-*` tokens let each host set
colors, typography, spacing, layout, and image bounds independently. The optional aiui bridge and
independent terminal example are demonstrated by the workbench's theme selector. See the
[styling contract](../docs/theming.md) for imports, supported hooks, and a completely custom view.

## Mapping and fold contract

- Tree badges show inclusive subtree UTF-16 code units and image placements. Hover or select to
  compare exclusive ownership with subtree totals. Generated syntax and escaped output count
  toward their recorded owner; reused definitions count separately per placement. Parent/child
  subtree totals overlap and must not be summed. Folding only affects visibility. Tokens remain unknown.
- Raw spans address half-open UTF-16 intervals inside a compiled text part. Generated syntax,
  escaped material, and authored content retain their compiler contribution ownership.
- The owned Markdown adapter wraps `mdast-util-from-markdown`, with math and GFM extensions.
  It takes every position from the original-source offsets; it never reconstructs positions by
  searching rendered text, adding token lengths, or matching decoded entities.
- Preview navigation exposes containing blocks and complete equations. It does **not** promise
  glyph-level TeX, decoded-character, or arbitrary browser-selection mappings. A preview range
  can have several contributing owners; all are offered in the provenance pane.
- Every contiguous compiled text part is parsed independently. An image is a real part boundary.
  Reference definitions and Markdown constructs do not span image boundaries in this version.
- Outline disclosure and content folding are independent. Inner content folds survive folding
  and reopening a parent. Reusing a definition never ties its occurrence fold state together.
- A fully folded preview block becomes a placeholder. A partially folded equation, table, or
  Markdown block remains complete and carries an explicit partial-fold notice. The canonical
  compiler output and copy actions never contain fold markers.
- Arbitrary HTML is displayed literally, links require safe explicit protocols, and Markdown
  image syntax remains authored text rather than becoming an undeclared multimodal asset. KaTeX
  uses `trust: false`, a bounded macro expansion limit, and visible error output.
- XML tags remain literal. CommonMark may recognize Markdown/math blocks between them; a full
  XML block can also remain literal. For an already recognized equation wholly contained in a
  compiler XML region, preview decodes one XML text-escaping layer before rendering math. Its
  original encoded output range is unchanged and navigation remains whole-equation precision.
  There is no general XML-aware document renderer or decoded-character mapping in this slice.

`mountComparison` provides two independent valid inspectors and exact record/output/decision
summaries. It does not infer moves, transfer fold state across revisions, or claim byte identity for
unversioned image contents. It compares asset descriptors as part of the output records.

## Test-first workbench

From the repository root:

```sh
pnpm --filter @habemus-papadum/aiui-prompts dev
pnpm --filter @habemus-papadum/aiui-prompts exec vitest run inspector
pnpm --filter @habemus-papadum/aiui-prompts build:inspector
```

The workbench runs at `http://127.0.0.1:5219`. Ports 5217 and 5218 remain the earlier independent
spikes. This bench shows real JSON storage/reloading, captured session facts and `Case` decisions,
split math, reused components, an image resolver, exact text, and consumer operation lowering.
Two new synthetic compositions additionally exercise mixed XML/Markdown/math delegation with a
budgeted structured tool brief, and bracket markers containing captured XML sidecars. Their event
and tool origins are inspectable. These examples are not reproductions of the legacy golden corpus.
Nothing is sent. Its example asset paths and remote URLs are explicitly illustrative bindings.
The Realtime example uses a valid one-pixel PNG data URI as a transport fixture, separate from
the generated preview chart. Binary data exists only in that prepared binding, never in the semantic
record. Digest-pinned imported assets require a host-provided binding; the illustrative workbench
does not claim that its fixtures match a recorded digest.

The first UI test line is jsdom with the real record validator, compiler, Markdown adapter, KaTeX,
mounted controls, and native DOM event dispatch. Tests cover re-derivation, versions/errors,
provenance, folds, reuse, partial equations/tables, inline image ordering/navigation and raw popup
hover/pin/Escape, clipboard seams, safe
preview construction, comparison, and disposal. Pure parser tests separately verify offsets across
CRLF, emoji, entities, escapes, code, and math. Consumer examples use the real lowering API.

Geometry, real font rendering, clipboard permissions, and pointer reachability need a browser.
There is no scroll synchronization, DOM-range selection adapter, virtualized large-document view,
in-browser TSX editor, or inferred cross-revision correspondence in this slice. Those features can
use the existing controller and range contract without changing the stored record.
