# Splitting the renderer out, and giving the composed prompt structured annotations

Status: **proposed, not started.** Recorded 2026-07-17 as a forward plan. The renderer split
(Part 1) is ready to do now; the annotations work (Part 2) is deliberately sequenced *after* the
trace preview settles into its own package (`aiui-trace-ui`, extracted in
[the overlay retirement](./dev-overlay-retirement.md)) — the point of the annotations is to let
the trace hero stop re-parsing prompt text, so the two land as one connected change on the trace
side once that package is the stable home for the hero.

This is a two-part proposal against the intent lowering pipeline
(`packages/aiui-lowering-pipeline`) and its one rich consumer, the trace viewer's lowered-prompt
hero (`packages/aiui-trace-ui`).

## Why

Two problems, one root.

`packages/aiui-lowering-pipeline/src/engine.ts` is ~1670 lines carrying four unrelated concerns in
one file: the `Engine` state machine, the `composeIntent` multi-pass compiler, the timestamp
interleave, and the item→text **rendering**. "How does a shot render into the prompt?" should be a
one-file question; today you read past 1200 lines of compiler to reach it.

More importantly, the way the **trace hero** shows a rich preview of the lowered prompt is a text
round-trip. The pipeline renders a shot to an XML string:

```
<screenshot path=".aiui-cache/…/shot_1.png">
  <element name="Legend" source="src/Legend.tsx:30:2">…</element>
</screenshot>
```

…and then `trace-view.ts` re-discovers that structure by running a regex back over the finished
prompt string to pull the thumbnail out again:

- `splitLoweredPrompt(text)` string-splits on the literal `"\n\n---\n\n"` to peel off the context
  preamble (`trace-cards.ts:617`).
- `parseShotBlocks(body)` runs `SHOT_BLOCK = /<screenshot\b…<\/screenshot>/g` over the body,
  then pulls `path="…"` / `marker="…"` back out of each match with more regexes
  (`trace-cards.ts:631,641,650`).
- the hero draws an `<img>` per match, resolving pixels via `shotBlobName` → `shot_1.png`
  (`trace-view.ts:267,284,303`).

The pipeline **already had** the structured facts (`marker`, `path`, `thumb`, `components`,
`viewport`) as `ComposedItem` fields; the renderer flattened them to a string, and the trace UI
spends a regex to recover them. That round-trip has three costs:

1. **It is coupled to the XML form.** `parseShotBlocks` matches `<screenshot …>` only. Under
   `shotFormat: "text"` (a real, plumbed config value — see the format note below) the
   `[screenshot: …]` blocks pass through as prose and the hero renders no images. The "format"
   knob and the preview silently contradict each other.
2. **The preamble boundary is a magic string.** `splitLoweredPrompt` depends on the exact
   `"\n\n---\n\n"` separator that `wrapWithContext` happens to emit
   (`aiui-claude-channel/src/prompt-context.ts:168`). Any change to that wording silently breaks
   the gray-out.
3. **The hero over-renders.** The owner's call: the hero should be **the raw prompt text**, as the
   agent sees it — with hover-preview hyperlinks over the shots and a de-emphasized preamble — not
   a reconstructed collage. Today it rebuilds a UI from parsed fragments instead of showing the
   text and annotating it.

The fix is to make `composeIntent` emit the structure it already knows as **offset-annotated
metadata over the prompt string**, so the hero renders raw text and overlays hyperlinks/hover
previews from the metadata — no regex, no XML assumption, no magic separator.

### Format note (context for Part 2's coupling claim)

`ComposeOptions.shotFormat` (`engine.ts:725`) selects the shot rendering: `"xml"` (default,
resolved by `renderShot`'s `?? "xml"`) or `"text"`. It originates as
`IntentPipelineConfig.shotFormat` (`config.ts`), read channel-side off the client hello
(`intent-v1.ts` → `oneOf(cfg.shotFormat, ["xml","text"], "xml")`) and threaded into compose. As of
this writing **nothing selects `"text"` in the shipped path** — it is reachable only as an opt-in
config value and via the pipeline's own tests. So the XML coupling in `parseShotBlocks` is latent,
not live — but it is exactly the kind of coupling the annotations remove for free, and it is why
Part 2 makes `shotFormat` a pure wording choice with zero effect on preview fidelity.

## Part 1 — extract `render.ts`, move the compose IR types

A mechanical, behavior-preserving split. The rendering cluster at the bottom of `engine.ts`
(~lines 1388–1674) is already dependency-light: the `render*` functions are **pure functions of
`ComposedItem` + `ComposeOptions`** with zero back-reference to `Engine` or any IR pass. The only
tie into the compiler is pass 5, `renderPass`, which drives them and assembles the result.

**New file `render.ts`** — "how the IR becomes prompt text", readable top to bottom:

- `renderPrompt(items, corrections, policy, options): ComposedIntent` — today's `renderPass`
  (`engine.ts:1177`), renamed to read as the module's public assembly entry.
- the item renderers: `renderShot` / `renderShotXml` / `renderShotText`, `renderAppSelection`,
  `renderCodeSelection`, `renderNavigation`, `renderTabSwitch`.
- their private helpers and constants: `pageLabel`, `formatOffset`, `shareAttrs`, `shareNote`,
  `relativizePath`, `escapeXml`, `SHORT_SELECTION_CHARS`, `MAX_CELLS_IN_PROMPT`,
  `MAX_ELEMENTS_IN_PROMPT`.

**`engine.ts` keeps** the `Engine` class, `composeIntent`, passes 1–4 (`scanStream`, `placeItems`,
`applyCorrectionsPass`, `interleavePass`), and the interleave helpers. Pass 5 becomes a one-line
call to `renderPrompt(...)`. The file drops ~290 lines.

**The one real decision — where the shared IR types live.** `render.ts` and `engine.ts` both need
`ComposedItem` / `ComposedIntent` / `ComposeOptions`. Leaving them in `engine.ts` creates a cycle
(engine → render for `renderPrompt`; render → engine for the types). So **move those three
interfaces into `types.ts`** — they are pure, browser-safe data shapes, exactly what `types.ts`
already holds (`IntentEvent`, `AppSelection`, `LocatedComponent`, …). The dependency graph is then
acyclic: `types.ts` ← `render.ts` ← `engine.ts`.

**Mechanical follow-through (small, guarded):**

- `index.ts`: re-point the `renderAppSelection` / `renderCodeSelection` / `SHORT_SELECTION_CHARS`
  exports from `./engine` to `./render`. The public package surface is unchanged. (The channel's
  realtime resolver re-uses those two `render*` fns verbatim so a live-referenced `sel_2`/`code_1`
  renders identically — keep them exported.)
- `engine.test.ts:2`: change its `renderAppSelection, renderCodeSelection` import from `./engine`
  to `./render` (one line). Alternatively `engine.ts` can re-export them for zero test churn, but
  re-pointing keeps the boundary honest.
- Move the render-specific unit tests (`engine.test.ts` "renderAppSelection…" / "renderCodeSelection
  …" / the `shotFormat: "text"` cases) into a new `render.test.ts`; leave compose/interleave tests
  in `engine.test.ts`.

**Guards:** `pnpm -C packages/aiui-lowering-pipeline test` (fixtures + unit) and
`pnpm test:packaging` (dist-shape) stay green. Pure move; both should pass untouched.

**Optional second cut (not in scope here):** the other natural seam is `Engine` (state machine,
~600 lines) vs. `composeIntent` + passes (the compiler, ~450 lines) → `engine.ts` + `compose.ts`.
Hold as a follow-on; Part 1's goal is renderer legibility, which `render.ts` alone delivers.

## Part 2 — structured prompt annotations, and a raw-text hero

`composeIntent` emits, alongside the `prompt` string, a list of **typed spans** over that string.
The renderer is the natural producer: `renderPrompt` is the single place that concatenates
`promptParts`, so it knows every part's offset and length as it builds the string. The hero then
renders raw text and overlays UI from the spans — no re-parsing.

### The shape

Add a field to `ComposedIntent` (the `meta: Record<string,string>` field is already vestigial —
`renderPass` sets `meta: {}` and its doc says shots no longer populate it; this can replace it, or
sit beside it during a deprecation window):

```ts
/** A typed region of the rendered `prompt` string — the structure the renderer
 *  knows, handed to consumers so they annotate text instead of re-parsing it.
 *  `[start, end)` are character offsets into `prompt`. */
export type PromptSpan =
  | { kind: "shot"; start: number; end: number; marker: string;
      path?: string; thumb?: string; viewport?: boolean;
      origin?: "paste"; share?: ShotShare; components: LocatedComponent[] }
  | { kind: "app-selection"; start: number; end: number; marker?: string;
      sourceLoc?: string; cell?: string; cellLoc?: string }
  | { kind: "code-selection"; start: number; end: number; marker?: string;
      sourceLoc?: string; lines?: number }
  | { kind: "navigation" | "tab-switch"; start: number; end: number;
      from: string; to: string }
  | { kind: "preamble"; start: number; end: number };

export interface ComposedIntent {
  // …existing fields…
  /** Offset-annotated structure over `prompt`. Consumers (the trace hero) use
   *  this to render raw text with hover-preview hyperlinks and a de-emphasized
   *  preamble — no regex over the prompt, no XML-form assumption. */
  spans: PromptSpan[];
}
```

Offsets are into the **body** `composeIntent` produces. The `preamble` span is added later, at
wrap time (below).

### Producing body spans in `renderPrompt`

`renderPrompt` builds `promptParts: string[]` and joins with `" "`. Rework it to track a running
offset as it appends, and for every non-text part push a `PromptSpan` with the `[start, end)` it
occupies in the final joined string (accounting for the single-space join and the `.trim()`). Each
`render*` call already returns the exact substring that lands in the prompt, so the span is
`{ start: offsetSoFar, end: offsetSoFar + rendered.length, …fields from the item }`. Text runs get
no span (they are the default). This is bookkeeping the renderer is uniquely positioned to do
correctly — it owns the string.

Note the interaction with the multi-line block forms: `renderShotXml`/`renderShotText` wrap
multi-line blocks in leading/trailing `"\n"`; the span must cover the block as it actually appears
post-join/trim. Deriving offsets **from the assembled string** (find each part's placement as it is
concatenated) rather than pre-computing avoids drift from the join/trim.

### Producing the `preamble` span at wrap time

The preamble is not `composeIntent`'s — it is the channel's. `wrapWithContext`
(`aiui-claude-channel/src/prompt-context.ts:168`) prepends the intro line, context sections,
`"The user's prompt follows."`, and a `"---"` rule, joined by `"\n\n"`, then the body. So the
channel is where the `preamble` span and the body-span offset shift belong:

- have `wrapWithContext` (or a thin `wrapWithContextAnnotated` beside it) return
  `{ text, preambleLen }` — `preambleLen` is the length of everything before the body, i.e. the
  offset the body was shifted by.
- the channel then emits the final `spans`: a `{ kind: "preamble", start: 0, end: preambleLen }`,
  plus every body span from `composeIntent` shifted by `+preambleLen`.
- record `spans` on the same trace stages that already carry `prompt`: `composed (speculative)`
  (`intent-v1.ts:734` — `data: { transcript, prompt }` → add `spans`) and the committed
  `lowered prompt` stage. This replaces `splitLoweredPrompt`'s magic-separator dependency with a
  real offset.

This keeps the seam honest: the pipeline annotates the body it renders; the channel annotates the
wrapper it adds. Neither reaches into the other's text.

### The hero, rewritten (in `aiui-trace-ui`, once it is the settled home)

`trace-view.ts`'s hero (`:240–320`) becomes: render `prompt` as raw text; walk `spans`; for each
span, wrap the covered substring in the right affordance:

- **shot** → an inline hyperlink/chip over the rendered block; on hover, show the thumbnail
  (resolve pixels from `marker`/`path` via the existing blob route — `shotBlobName` logic stays,
  fed by the span's fields instead of a regex capture).
- **app-selection / code-selection** → a hyperlink to `sourceLoc` (and cell/cellLoc when present).
- **navigation / tab-switch** → a subtle inline marker (these already render as parentheticals).
- **preamble** → gray it out / shrink it / make it collapsible, using the span's `[0, preambleLen)`
  instead of `splitLoweredPrompt`.

**Deletions this enables in `trace-cards.ts`:** `SHOT_BLOCK` (`:631`), `parseShotBlocks` (`:641`),
`PromptSegment` (`:627`), and `splitLoweredPrompt` (`:617`) all go away — the hero no longer parses
the prompt at all. `shotBlobName` (`:674`) stays (path → blob basename is still useful), now driven
by span fields.

The other preview surface — the debug-page IR pane, `event-panes.ts` `renderIr` (`:163`), which
runs `composeIntent` live and shows `composed.prompt` as **plain text** — needs no change, but can
optionally adopt the same span overlays for consistency.

## Sequencing and dependencies

1. **Part 1 first** (renderer split + type move). Standalone, behavior-preserving, unblocks Part 2
   by giving the spans a clean home (`render.ts` owns both the string and its annotations).
2. **Part 2a — pipeline emits body spans.** Add `PromptSpan`/`ComposedIntent.spans`; `renderPrompt`
   records them. Pipeline tests assert spans cover the right substrings. No consumer change yet;
   `spans` is additive and ignored by anyone who does not read it.
3. **Part 2b — channel emits the `preamble` span + shifts body spans**, records `spans` on the
   trace stages. Still no visible change.
4. **Part 2c — the hero rewrite**, done once `aiui-trace-ui` is the stable home for the preview
   (the ordering the owner asked for). This is where `parseShotBlocks`/`splitLoweredPrompt` die and
   the hero becomes raw-text-plus-annotations.

Parts 2a/2b can land ahead of 2c behind the additive `spans` field, so the risky consumer rewrite
is a small, isolated last step with the data already flowing.

## Non-goals / open questions

- **Not** changing what the prompt text *says* — spans annotate the exact string the agent already
  receives. Byte-for-byte identical prompts; only the sidecar metadata is new.
- **`shotFormat` after this:** with the hero reading spans, `"xml"` vs `"text"` becomes a pure
  wording choice for the agent with no preview consequence. Worth revisiting whether the `"text"`
  branch earns its keep at all, but that is a separate call.
- **Offset fragility across `.trim()`/join:** derive span offsets from the assembled string, not
  pre-computed lengths, so the final `.trim()` and the `" "` join can't desync them. The
  pipeline's fixture suite is the regression net.
- **Wire/versioning:** `spans` is additive to `ComposedIntent` and to the trace stage payloads;
  older traces simply lack it and the hero falls back to raw text with no overlays. No breaking
  wire change.
