# Where the sent prompt's spans live in the trace

Status: **decided and implemented** (2026-07-17) as part of
[render-split-and-prompt-annotations](./render-split-and-prompt-annotations.md). This is the one
design call in that change that had real alternatives; recorded here so the choice — and the door
left open — is legible.

## The issue

Part 2 of the render-split work makes `composeIntent` emit `ComposedIntent.spans`: offset-annotated
`PromptSpan`s over the prompt string, so the trace hero can render raw text with hover-preview
links and a dimmed preamble instead of re-parsing the prompt with a regex.

The hero displays a committed turn's prompt from the **`lowered prompt` trace stage** — the
*wrapped* prompt (context preamble + body) that was actually sent. For the hero to overlay spans on
that text, the wrapped spans (a `preamble` span plus the body spans shifted past it) have to be
present in the trace.

The catch: **`intent-v1` does not record the `lowered prompt` stage.** It is recorded generically by
the tracing wrapper in `tracing.ts`, which wraps `ctx.sendPrompt` for *every* channel format:

```ts
sendPrompt: async (text, meta) => {
  trace.record({ kind: "output", label: "lowered prompt", data: meta ? { text, meta } : text });
  await ctx.sendPrompt(text, meta);          // the real send
},
```

That wrapper is format-agnostic and only ever sees `(text, meta)`. It has no concept of a
`PromptSpan`. So the wrapped-prompt spans must reach the trace by some path *other than* that
stage's own recording. That constraint is what forces a choice.

## Options considered

### A — a plain separate stage (the proposal's original sketch)

`intent-v1` records `{ label: "lowered prompt spans", data: { spans } }`.

- Simplest to write.
- **Problem:** `classifyStage` turns every stage into a **card** in the viewer (its fallthrough is
  "unknown label → generic internal card, never drop"). Every real sent trace would grow a visible
  "lowered prompt spans" card that just dumps the span array — noise, duplicating what the hero
  already renders from those same spans.

### B — teach the transport contract to carry spans

Widen `SendPrompt = (text, meta?) => …` to `(text, meta?, opts?: { spans }) => …` so the tracing
wrapper can fold spans into the **same** `lowered prompt` stage.

- One stage, no phantom card — the cleanest data model (annotations live with the text they
  annotate).
- **Problem:** `SendPrompt` is the channel's **generic transport contract** — how *any* prompt
  reaches *any* session, implemented by the outer host (the `aiui` package) and others. `PromptSpan`
  is an intent-pipeline concept. Threading it through the transport signature makes the transport
  layer depend on the lowering layer. That is a layering smell: a pipeline detail leaking into code
  that has no business knowing about it.

### C — separate stage, classified invisible (chosen)

Keep A's stand-alone `lowered prompt spans` stage (transport contract untouched), and add one
`classifyStage` rule routing that label into the **`compose` category** — the same bucket the
"speculative compose" IRs already live in, which the viewer **hides by default**. The hero pairs the
`lowered prompt` text stage with the nearest `lowered prompt spans` stage to recover the spans.

- No transport-contract change; no phantom card in the default view; the data is still there as
  debug detail if you toggle the internal/compose chip on.
- **Cost:** a hidden extra stage, and a little data duplication (the spans also exist transiently on
  the pushed `lowered-prompt` message).

## Decision

**Option C.** It keeps both the layers clean *and* the default trace view clean, and the only price
is a hidden, self-describing debug stage. B is the next-most-defensible if we ever decide `SendPrompt`
*should* legitimately know about spans — but that is a deliberate widening of the transport contract,
not a side effect of this change, so it stays out.

Implementation touches: `intent-v1.ts` records the stage; `trace-cards.ts` `classifyStage` routes it
to `compose`; `trace-cards.ts` `heroPrompt` reads it back; `wrapWithContextParts` supplies the
`preambleLen` used to build the wrapped spans.

## The door left open

The narrow open question is: **should the sent-prompt spans be a trace stage at all?** If a future
reader dislikes C, the honest alternatives are:

- **Fold them into the `lowered prompt` stage** — which means option B (contract change), *or* a
  larger refactor where `intent-v1` takes over recording that stage from the generic tracer.
- **Have the hero derive them** — recover `preambleLen = wrapped.length − body.length`, then shift
  the body spans (which already ride the `composed intent` stage). No new stage — but this
  reintroduces exactly the offset arithmetic in the consumer that the whole change set out to
  delete. It is the fragility we removed, just relocated.

C was chosen over both because it removes the derivation coupling *and* the transport coupling at the
cost of one hidden stage.
