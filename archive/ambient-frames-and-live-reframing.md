# Ambient Frames & the Role of Realtime (thinking notes)

Status: **exploratory** — recorded thoughts, not committed design (July 2026). Companion to
the concepts page [Realtime Live Mode](../guide/realtime-live.md), which documents what *is*.

Three connected ideas, from a working session on the live-mode internals.

## 1 · Fewer, longer turns + labeled frames on a cadence (live tiers)

Today every talk-window end is a live turn — and that's not only the Space release: the
**silence endpointer auto-splits** a hold/toggle at ~900 ms of quiet, so every pause hands the
model a chance to respond (and bills a response over the accumulated session). Toggle-talk
(`talkMode: "toggle"`) already exists, but it does not deliver "one turn until I untap" —
the endpointer still splits.

The idea:

- Talk in **long windows** (toggle mode, endpointer disabled or greatly relaxed in the live
  submode), so a session has few actual turns.
- Send ambient frames on a slower cadence (~5 s), **labeled** (`[image frame_12]`) on *both*
  vendors — Gemini as stream frames, OpenAI as conversation items — and register them like
  shots, so the model can reference any frame in its `submit_intent` segments, not just
  deliberate D/S shots.
- With few turns, the vendors' billing curves converge (the per-turn re-read is what
  separates them), making OpenAI's items-only image path viable.

Engineering notes for later: a referenced frame must exist on disk to be re-attached at
resolve (today only every 10th ambient frame is persisted, for the trace); labels are cheap
but each *labeled* frame becomes referenceable context the model re-reads — cadence and
retention need a budget; the endpointer serves transcription-mode pseudo-streaming, so any
change is live-submode-scoped.

## 2 · Ambient frame capture for the NON-live tiers ("recorded demo" mode)

The live tiers own video today, but conceptually nothing about frame capture requires a live
model: capture screenshots on a cadence in transcription mode, ride them on the engine stream
as events (like shots — markers, thumbnails, retraction), and let **lowering** decide what
survives. That turns the frame stream into an IR and frame selection into a compiler pass —
the project's whole thesis applied to video:

- **Coalescing rules** at lowering time, not capture time: if no ink landed between two
  frames, keep only the newer (or drop both); dedupe near-identical frames; cap totals.
- **Tweak mode keeps everything**: if you're in tweak mode while capturing, you are almost
  certainly *demoing* a behavior — the inter-frame differences are the content, so no
  coalescing.
- **Edit/correct mode pauses capture** (or at least rendering into the feed) so editing the
  transcript doesn't pollute the visual record; capture resumes on return.
- The composed prompt then interleaves transcript, ink-annotated shots, and the surviving
  frames — a "recorded demo" the agent can read, produced with zero live-model cost.

Open questions: markerless vs. markered frames (are coalesced frames referenceable in
corrections?); preview UX (a frame strip? only survivors?); disk/trace budget; whether the
coalescing pass runs client-side (compose preview must match) or channel-side (lowering owns
it — likely both, shared like `composeIntent`).

## 3 · Reframing what realtime models are *for*

> **Superseded:** this section grew into its own design sketch —
> [Realtime Models as Prompt Linters](./realtime_prompt_linter_design.md) (with a first-steps
> plan in [realtime_pivot_plan.md](./realtime_pivot_plan.md)). Kept below as the original
> framing.

The uneasy observation: realtime models may be miscast as **prompt composers**. Referencing a
specific frame in a continuous video is exactly what attention over a long multimodal session
is bad at — our label grammar mitigates but doesn't remove that. Where realtime models shine
is **interaction**: you don't yet know what you want to say, and the model helps you find out
— asks the clarifying question, resolves the ambiguity aloud, keeps up while you point and
tweak.

That suggests a decomposition:

- **Live model = disambiguation partner.** Its job is the conversation itself — clarify,
  confirm, ground deictic speech while it's still cheap to ask.
- **Composition = a lowering pass at fin**, run by a strong *batch* multimodal model (or the
  coding agent itself) over the recorded chronicle + surviving frames + selections. Notably,
  the architecture already contains this shape: the chronicle is kept in full, and the
  `composeIntent` fallback *is* a batch composition — the reframing amounts to promoting the
  fallback path to primary with a smarter compiler, and demoting `submit_intent` from "the
  composer" to one input among several (the live model's summary of what was agreed).

The tension to resolve: the live model has context a batch composer can't fully recover (what
it said aloud, what the human confirmed against which frame) — the chronicle records the
words but not the grounding. If the live model's job is interaction, its *output* worth
keeping may be exactly that grounding: which ids were talked about, what was agreed — a
structured trace for the batch composer, not the final prose.

None of this changes the current implementation; idea 2 is buildable independently of the
live tiers, and ideas 1/3 are experiments the `LiveSession` seam and the trace debugger were
built to make cheap.
