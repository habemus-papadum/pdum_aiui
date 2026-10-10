# Chunks — a partition primitive for the prompt toolkit

*Status: IMPLEMENTED 2026-10-10, same day, with the owner's go-ahead. Written from the one
consumer that needs it (the live session's appends) after the structured-prompts migration closed
everything else — see `structured-prompts-review.md`. The text below is the proposal as written;
the deltas taken while building it:*

- *The default boundary order includes `line` (paragraph, line, sentence, word, character): a
  newline is a stronger cut than a sentence end inside a line.*
- *`marker` is a string, like `Elide`'s, not a prompt value.*
- *The decision's `cuts[].at` counts each image as one slot beside the text's code units; the
  compiled artifact carries `cuts` as part positions (`{ part, offset }`, an image part at offset
  0), which is what `chunksOf` slices by.*
- *`chunksOf` returns slices of part ranges (`{ part, type, text, start, end }` or an image part),
  not compiled prompts; the delivery map for a chunk is a new `slice` relation carrying its
  `source` range, since `copy` means a whole part.*
- *The live session omits the chunk reference when a text is one chunk; the ledger row reads
  `commentary 2/3` when it is not.*
- *Errors: `CHUNK_OVERFLOW`, `ATOMIC_CHUNK`, `CHUNK_SIBLINGS`, `CHUNK_MULTIPLE`, `CHUNK_NESTED`,
  `CHUNK_ELISION` (a character/line elision cannot window through a chunk), and
  `CHUNK_COUNT_MISMATCH` at lowering.*
- *The inspector's ruler is a list under "Provenance and decisions" (one row per chunk: size over
  limit, the boundary kind and offset of its cut) plus a note on a chunked delivery; the graphical
  ruler can come later.*

## The gap

The Realtime API caps one context append at 500 tokens (`APPEND_TOKEN_LIMIT` in
`packages/aiui-live/src/protocol.ts`; the server rejects a longer one as `invalid_value`). A backend
result longer than that is split by the live session — `chunkForAppend` in
`packages/aiui-live/src/tokens.ts`: sentence ends first, then whitespace, then a hard cut, each
chunk at most 70 percent of the cap by the toolkit's conservative estimate — and every chunk is
sent as its own append event.

Since the migration each chunk is already a session operation: a one-`Text` record, lowered by the
`live-session/1` profile, captured as its wire, verified. What the ledger cannot say is that three
`append` entries were one result, where the cuts fell, why they fell there, and how much headroom
each chunk had. The split is a decision the toolkit never sees, taken by a function the toolkit
cannot replay. The migration's rule was that every decision about what the model reads is recorded
— the cut is one, and it is the last unrecorded one on this path.

## What the toolkit has, and why none of it fits

- **`Elide`** decides what the model does *not* read: it clips to a budget, keeps one end, records
  what was omitted. A chunk omits nothing. Expressing a chunk as an elision would need N elisions
  of one text with N different windows, each a separate record, and the "nothing omitted" property
  would be a reader's inference rather than the record's statement.
- **`Choice` / `Case` and `selection`** pick among authored variants. A chunk is not authored; its
  count depends on the estimator and the budget. And `options.selection` is part of a record's
  fingerprint, so addressing "chunk 2" through a selection would make every chunk a different
  record — the opposite of the link the ledger needs.
- **Session operations** bind exactly one record and lower to exactly one payload, which is the
  invariant `captureWire` and `verifyWire` stand on and the ledger's one-entry-per-wire shape. A
  chunked send must keep it.

So: a *partition* primitive in the semantic layer, where the cut is computed at compile time,
recorded as a decision, and replayable; and a per-operation *chunk index* in the operation layer,
where each envelope stays one operation with one wire.

## The primitive

```ts
Chunk({
  unit: "tokens" | "characters",
  limit: number,
  boundaries?: readonly ("paragraph" | "line" | "sentence" | "word" | "character")[],
  marker?: PromptValue, // prefixed to every chunk after the first; none by default
  label?: string,
  children,
});
```

**Semantics.** The node's children compile as they would anywhere; the chunk then cuts that run of
parts into consecutive windows, each within `limit` under the compile services' estimator (the
same `TokenEstimator` elision uses, the conservative default when none is given). Nothing is
dropped or reordered: the chunks concatenated are the un-chunked rendering, plus any markers. The
boundaries list is a preference order, strongest first; the default is paragraph, sentence, word,
character.

**The cut rule.** Fill greedily from the start. When the next unit would overflow, cut at the
strongest boundary available inside the current window; a window with no boundary of any listed
kind is an overflow, `CHUNK_OVERFLOW`, unless `character` is listed (it always is by default, so
plain text always chunks). The boundary kinds are fixed by the toolkit, not the host: a paragraph
boundary is a blank line, a line boundary a newline, a sentence boundary the position after `.`,
`!` or `?` followed by whitespace, a word boundary whitespace, a character boundary any UTF-16
index that does not split a surrogate pair (the elision's Unicode rule). Whitespace at a cut
belongs to the chunk before it — nothing is trimmed, so concatenation reproduces the original.

**Atomic regions.** A cut never lands inside a math scope, an XML element, or a tool projection —
the regions elision already refuses to split (`ATOMIC_ELISION`). The chunker treats such a region
as one unit: it rides in the window being filled if it fits, otherwise opens the next window;
alone over the limit it is `ATOMIC_CHUNK`. An image part is atomic the same way, costed by the
estimator's image rule.

**The marker.** When given, it is prefixed to chunks 1 through N−1 as generated text attributed to
the chunk occurrence (the relation elision's marker has), and counted against that chunk's budget.
The live host passes none; a `"(continued)"` marker is a host's choice for a model that benefits
from it.

**The decision.** One per chunk occurrence, so a reader sees the whole partition at once:

```json
{
  "occurrence": "o:…",
  "kind": "chunk",
  "selected": "3",
  "detail": {
    "unit": "tokens",
    "limit": 350,
    "estimator": { "name": "aiui-prompts/conservative", "version": "1" },
    "count": 3,
    "cuts": [
      { "at": 1180, "boundary": "sentence" },
      { "at": 2399, "boundary": "paragraph" }
    ],
    "tokens": [338, 349, 120]
  }
}
```

`selected` is the count as a string (the field is a string on every decision kind). `at` is an
offset in the occurrence's own rendered text, so the inspector can draw the ruler without
re-chunking. `tokens` is per chunk — the headroom is the thing a host tunes.

**Compiled output.** The chunk's parts carry a region of kind `chunk` with the index, beside the
`xml` and `math` regions compile already emits. One helper slices by it:

```ts
chunksOf(compiled): readonly CompiledPrompt[]
```

Each element has its own parts and mappings, source ranges unchanged (they point into the whole
record, which is the point). A compiled prompt with no chunk occurrence is one chunk. A prompt
delivered chunked must have exactly one chunk occurrence and no parts outside it — a heading
beside the chunk would belong to no chunk and break the budget — and `chunksOf` refuses anything
else as `CHUNK_SIBLINGS`. (A chunk nested inside other content is still fine to *author* — the
decision is recorded, the inspector shows the ruler — it just is not deliverable as chunks.)

## The operation side

The session body gains an optional chunk reference:

```ts
sessionOperation(record, {
  action: "append-commentary",
  sessionId, eventId, delegationId,
  chunk: { index: 1, count: 3 },
});
```

The operation still binds one record — the *whole* one, shared by all three operations through
its fingerprint, which is exactly the link the ledger lacks today. Lowering compiles the record,
slices with `chunksOf`, checks `count` against the decision (`CHUNK_COUNT_MISMATCH` otherwise: the
host's idea of the partition must be the record's), and builds the event from chunk `index`'s
parts. The delivery map's bounds are relative to the event's text, its origin ranges into the
whole record. `captureWire` and `verifyWire` do not change: one operation, one payload, one
verdict per chunk. Only `live-session/1`'s `append-*` actions accept `chunk` for now; every other
profile rejects it (`CHUNK_UNSUPPORTED`) until a second consumer with a cap appears — the Responses
input and the channel push have none.

The cap itself stays the host's constant. The toolkit records the *limit the host chose* and the
estimate it was checked against; it does not know the vendor's number, and should not.

## The inspector

Over a record: a ruler under the chunk occurrence — one segment per chunk, labelled with its
tokens over the limit and the boundary kind at each cut; selecting a segment highlights its span.
Over an operation with `chunk`: a badge, "chunk 2 of 3", and the highlighted segment; a wire
loaded for it verifies that chunk alone. The ledger widget in aiui-live groups `append` entries
by record fingerprint so the three rows read as one result in three envelopes.

## The host's migration (aiui-live)

`LiveSession.append` renders once and sends N times:

```ts
const rendered = renderPrompt(
  Chunk({
    unit: "tokens",
    limit: Math.floor(APPEND_TOKEN_LIMIT * 0.7),
    children: [Text({ value: text, origin: { site: `aiui-live append ${kind}`, delegation } })],
  }),
);
for (const [index, chunk] of chunksOf(rendered.compiled).entries()) {
  const operation = sessionOperation(rendered.record, {
    action: `append-${kind}`, sessionId, eventId: nextEventId(), delegationId,
    chunk: { index, count: chunks.length },
  });
  // lower → send → ledger entry { prompt: rendered.record, operation, wire }
}
```

`tokens.ts` (`approxTokens`, `chunkForAppend`) and its test are deleted; the AppendLab page of the
live demo shows the chunk decision through the inspector instead of its own list. No corpus is
affected: appends are not in one.

## Alternatives considered

- **A multi-envelope delivery** — `lowerOperation` returning a sequence of payloads for one
  operation. Rejected: it reshapes the one-operation-one-wire invariant every consumer, the
  capture, the verifier and the ledger stand on, for the benefit of one path. The shared record
  fingerprint plus `chunk.count` carries the link without it.
- **Host-side chunking with only a `chunk` parameter on the operation.** Rejected: the cut points
  would be unrecorded and unreplayable, and the host would keep its own estimator — the exact
  duplication removed on 2026-10-10 (the live estimate now delegates to the toolkit's).
- **Chunk as a selection** (`selection: { chunk: 2 }`). Rejected above: selection is identity.
- **Trimming whitespace at cuts**, as `chunkForAppend` does. Rejected: it breaks the
  concatenation property for a cosmetic gain; an append does not care about a trailing newline.

## Open questions for the owner

1. Should a chunk inside an `Elide` with `unit: "tokens"` be counted whole or by its first chunk?
   Tree order says the elision sees the whole, which is the honest reading; flagging it in case
   the elision's whole-children rule wants a special case.
2. Is `characters` as a unit worth keeping? It is trivial and a byte-capped transport will want it,
   but it is a second code path to test.
3. The decision records `at` offsets in the occurrence's text. If the inspector would rather have
   part indices and in-part offsets (the mapping vocabulary), say so and the shape follows.

## Plan

1. **Toolkit core** — `Chunk` in `model.ts`, validation in `record.ts`, the cut algorithm, the
   `chunk` region and `chunksOf` in `compile.ts`, the decision, tests (boundaries in preference
   order, atomic regions, images, overflow, markers, replay under another estimator), the
   record-contract and getting-started notes.
2. **Operations** — `chunk` on the session body for `live-session/1` appends, the slice and count
   check in lowering, a verify test per chunk.
3. **Inspector** — the ruler, the operation badge, the per-chunk verification.
4. **aiui-live** — `append` over `Chunk`, `tokens.ts` deleted, the ledger grouping, AppendLab.

Steps 1, 2 and 4 are small; 3 is the only medium one. 4 can land before 3 — the records are
useful in the ledger's JSON before the ruler exists.
