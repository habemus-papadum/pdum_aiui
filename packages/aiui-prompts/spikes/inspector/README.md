# Prompt inspector interaction spike

An unpublished, source-controlled testbench for linked raw text, Markdown/LaTeX, source, and
composition views. This is disposable implementation, kept to help decide the production contracts.
It does not import the authoring spike, legacy prompt logic, Solid, or any other aiui runtime.

From the repository root:

```sh
pnpm --filter @habemus-papadum/aiui-prompts-inspector-spike dev
```

Open <http://127.0.0.1:5217>. The loopback port is strict: an occupied port fails rather than
silently selecting another. `build`, `typecheck`, `test`, and `lint` are also package scripts.

## What to inspect

The app opens the scientific fixture. All artifacts and source locations are hand-authored fixtures,
clearly labeled in the UI. The Markdown parser and KaTeX rendering are real; there is no compiler,
provider SDK, live model call, tokenizer, or automatic optimization behind the UI.

| Example | Expected behavior |
| --- | --- |
| 01 Greeting | A single paragraph spans three raw contributions. Selecting the preview offers both owners. |
| 02 Reuse | The same evidence definition appears at heading levels 2 and 3. Folding the first occurrence leaves the second visible. Revision B omits background. |
| 03 Science | A valid equation is split across two contributors, followed by aligned TeX and text–image–text. Images differ by revision while dimensions and alt text remain equal. |
| 04 Table | Values preserve lexical zeros. A table spans several contributors, including separately selectable mass cells. Revision B changes one value. |
| 05 Comparison | Before and after are independently parsed documents with explicit corresponding occurrence IDs. Image and text changes are identified. |

## Interaction checklist

1. Select **Numerator + generated syntax**, then **Fold selected**, or its adjacent **Fold** button.
   The exact raw contribution folds; the intact equation stays visible with a partial-fold badge.
   Fold the denominator too to hide the whole equation. Neither operation changes copied payloads.
2. Expand all, fold the numerator, fold its parent **Shared equation**, then show that parent.
   The numerator's earlier fold intent survives.
3. Use a tree chevron. Only outline rows disappear; raw and preview content stay unchanged.
4. Select a raw span, **Locate equation**, a contributor chip, or a fixture source line.
   Relevant panes highlight and scroll to a logical match. Equation navigation is honestly at
   whole-equation precision; individual TeX glyphs do not claim exact source mappings.
5. Hover the raw image chip. Click it or press Enter/Space to pin the same image popup.
   Escape/Close returns focus. A fold or revision replacement closes the popup. All image bytes
   are local, authored SVG fixture data; there is no external image fetch.
6. Switch to **02 Reuse** and fold one placement. The other occurrence remains visible despite
   sharing a definition. Switch revisions; known keys preserve fold intent, deleted selections clear.
7. Enable comparison. Each side keeps its own valid Markdown/TeX. Corresponding selections and
   folds link when enabled. Select the removed background: the status reports that no counterpart
   exists. There is no invented positional match.
8. Copy exact text for a text-only fixture, or ordered parts JSON for multimodal content.
   These always read the complete original artifact, including presentation-folded content.
   The request panel separates the current authored turn from the fixed history reference.
9. Toggle **Sync scrolling** and scroll a long raw/preview pane. The other pane follows a coarse
   occurrence/block anchor. Disable it to inspect the views independently.

## What is real, what is mocked

- `model.ts` assembles exact text parts and their UTF-16 ranges in one pass. No rendered-string
  searches or proportional character alignment are used. Contributions partition text parts.
- `fixtures.ts` defines immutable-by-convention artifacts, displayed TSX snippets, source line
  maps, shared-definition identities, explicit occurrence correspondence, and asset revisions.
  The snippets are illustrative source, not executed code or the sibling spike's authoritative API.
- `preview.ts` lexes each complete text part before projecting folds. A table or equation can span
  many contributors. Assets are declared presentation boundaries in this experiment. KaTeX receives
  original math without injected navigation wrappers. Source ranges are block-level, not glyph-level.
- `state.ts` owns selection, outline disclosure, presentation folds, comparison, and revision changes.
  Parent folding leaves descendant intent intact. Counts use partitioned original contributions,
  so nested folds cannot double-count text. Counts are **UTF-16 code units**, never claimed tokens.
- `views.ts` renders those projections; `main.ts` binds application events and coarse scroll anchors.
  `image-popup.ts` owns the overlay lifecycle. Clipboard actions read canonical fixture data.

## Deliberate limits and architecture questions

This is a small synchronous DOM app, not a production viewer. It rerenders after commands and retains
logical selection, scroll offsets, and selected control focus; it has no virtualization, streaming
parser, layout epoch index, arbitrary text selection map, editable TSX, file-editor integration, or
large-artifact performance claim. Comparison detects content changes through known fixture keys;
it does not discover moves, unknown correspondence, or character-level edits.

Only repository-authored fixtures are rendered. The preview is **not** a general untrusted HTML
viewer. Its Marked token raw lengths cover these fixtures; arbitrary Markdown normalization,
reference definitions, CRLF preview mapping, custom macros, and inline math need a real parser-map
contract before accepting external documents. Exact raw range construction itself preserves CRLF,
entities, repeated text, and astral Unicode and has a regression test.

Folding a table cell leaves the whole table visible with a badge. That is intentional evidence for
a future fine-grained table map, not a completed cell projection algorithm. Similarly, an equation
offers contributor navigation while remaining mathematically intact. Generated math delimiters are
assigned explicit fixture owners, not claimed to originate in those contributors' source strings.

The next architecture discussion should settle: how much coarse ownership is sufficient; where
generated syntax attribution belongs; whether per-block contributor controls are too noisy; and how
logical anchors, accessible focus, revision cancellation, and future arbitrary range selection will
survive a production renderer without modifying canonical text.

Eleven pure tests cover fixture range/source coverage, complete Markdown/KaTeX parsing, split math,
UTF-16 raw boundaries, partial/nested/independent folds, revision reconciliation, correspondence
gaps, changed image identity, immutable payloads, and separate history. Browser review is additionally
needed for geometry, focus, hover, and clipboard behavior.
