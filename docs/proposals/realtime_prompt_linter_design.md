# Realtime Models as Prompt Linters (design sketch)

> **Status: IMPLEMENTED (July 2026).** The pivot shipped — the linter sidecar, linter-only
> engines, streaming-only transcription, the append-only preview, and the docs
> ([Prompt Linting](../guide/prompt-linting.md), [Realtime Live Mode](../guide/realtime-live.md)).
> This document is the design record.

Status: **proposal** — direction agreed in principle (July 2026), not yet implemented.
Supersedes and sharpens §3 of
[Ambient Frames & the Role of Realtime](./ambient-frames-and-live-reframing.md). What exists
today is documented in [Realtime Live Mode](../guide/realtime-live.md) /
[the wire page](../guide/realtime-vendors.md); the plan for the first mechanical steps is
[realtime_pivot_plan.md](./realtime_pivot_plan.md).

## The reframing

Today's three expensive tiers split by *who composes the prompt*:

| Tier | Model | Role today |
| --- | --- | --- |
| `flagship` | `gpt-realtime-2` | voice veneer — answers aloud, **composeIntent composes** |
| `live-openai` | `gpt-realtime-2` | **the model composes** (`submit_intent`) |
| `live-gemini` | Gemini Live | **the model composes** (`submit_intent`), plus video |

The proposal: realtime models are miscast as composers. Referencing a specific frame of a
continuous session is what long-context multimodal attention is bad at; the label grammar
mitigates but doesn't remove it. What a realtime model is uniquely *good* at is being present
while you think: it hears the fragmentary dictation, sees the screen, and can ask the
clarifying question at the moment it's cheapest to answer.

So: **one compiler, always** — the stream lowers through the same pipeline
(`composeIntent` → lowering passes) in every tier — and the realtime model becomes a
**prompt linter**: a diagnostics pass that runs *alongside* authoring and improves the source
before compilation. It never writes the program.

The tier table collapses accordingly (flagship and `live-openai` are the same model and wire,
differing only in persona — merged, they're one "OpenAI advanced" tier):

| Tier (proposed) | Model | Role |
| --- | --- | --- |
| OpenAI advanced | `gpt-realtime-2` | voice + **linter** |
| Gemini advanced | Gemini Live | voice + **linter** + video (sees the screen) |

## What the linter does

After each turn (cadence TBD — see open questions), the model is prompted to review the
content so far — transcripts, labeled shots, selections — and surface **diagnostics**, spoken
briefly and/or folded into the stream:

- *"The transcription says 'beat config' — from context you seem to mean 'Vite config'.
  Worth correcting."*
- *"You said 'make this wider' twice about different elements — the prompt will be ambiguous;
  which one is it?"*
- *"You referenced the legend but never shot it — take a screenshot so the agent can see it."*

The user clarifies (talk, correct mode, another shot) and the *source* improves; the compiler
compiles the improved source exactly as it would have anyway.

## Linter tools, and folding them into the trace

The linter gets read-only tool calls — read a file the selection points into, read the full
text behind a clipped selection label, list the shots so far. Each call is serviced by the
channel (filesystem) or, where the content lives in the page, by the browser via the existing
page-tools bridge. The key design rule: **the tool-call request and its response are both
appended to the thread's event stream as first-class, annotated events** (`linter-tool-call` /
`linter-tool-result`, alongside new `linter-note` events for spoken diagnostics). Then:

- the **trace debugger** shows exactly what the linter did — what it read, what it suggested,
  what it cost;
- the **compiler's first pass ignores linter events** wholesale (one `kind` filter — the same
  append-only discipline as shot retraction: nothing is deleted, passes decide what matters);
- a later pass *may* choose to use them (e.g., a diagnostic the user acted on explains a
  correction).

This keeps the linter honest and inspectable: it is a participant in the trace, never a hidden
voice.

## Why this fits the architecture

- **Flagship already has the shape.** The voice veneer answers aloud while `composeIntent`
  composes — the pivot upgrades its persona (from "answer questions" to "lint the emerging
  prompt") and adds tools, rather than inventing a new mode.
- **The chronicle is already the source of truth.** The live tiers keep the full transcript
  stream and fall back to `composeIntent` when the model fails to compose — the pivot promotes
  that fallback to the only path and deletes a failure mode (the drain timeout, the empty
  `submit_intent`, the "model composed something the user didn't say").
- **The grounding the composer path was buying is preserved** where it matters: the linter
  still lives in the session, still sees labeled shots and selections, and its diagnostics can
  cite ids. What was agreed in conversation lands in the stream as linter events + the user's
  own clarifying acts — which the compiler *does* see.
- **`submit_intent` doesn't have to die** — it can shrink into the linter's closing act: a
  structured "what was discussed/agreed" summary (ids ↔ resolutions) recorded as a trace
  event for later passes, rather than the authoritative prompt.

## Open questions

- **Cadence:** lint after every talk window? Only on demand (a key)? On a token budget? Every
  turn is billed over the accumulated session — chatty linting is expensive linting.
- **Diagnostic form:** purely spoken, or structured events with severity and a target
  (`{ about: "seg_4" | "shot_2", suggestion: … }`) that the preview could render as
  squiggles-like chips? Structured diagnostics could feed the correction pipeline directly
  (a "quick fix").
- **Turn economy:** the pivot pairs naturally with killing the silence auto-split (see the
  plan) — long talk windows, few lint passes, bounded cost.
- **Does the linter speak uninvited?** Barge-in exists; an eager linter interrupting mid-flow
  could be exactly wrong. A "raise hand" signal (status-line diagnostic, spoken only when the
  user pauses deliberately) may fit the peripheral-signal design language better.
- **Vendor asymmetry stays:** Gemini's linter sees the screen (ambient video); OpenAI's lints
  transcript + labeled stills only. Same role, different acuity — the capability seam already
  expresses this.
