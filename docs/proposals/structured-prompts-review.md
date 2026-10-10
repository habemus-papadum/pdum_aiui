# Structured prompts — a review from the sites that will consume it, and a staging plan

Status: REVIEW, 2026-10-09, written against [structured-prompts.md](./structured-prompts.md)
(the proposal) and [prompt-sites.md](./prompt-sites.md) (the survey of where this repo builds
model-facing text today). Part 1 steers the design before the work starts; part 2 says how the
existing sites would move onto the toolkit once it exists, and what can be done now to make that
move cheap. Site identifiers (OR3, LP4, …) are the survey's.

The one principle both parts serve, stated by the owner: **the structured prompt is the primary
object.** It is what gets saved, inspected and compared; rendering happens once, at the send
boundary; the rendered string is kept only as the low-level check that the renderer did what the
structure says. Stay structured as long as possible.

## Part 1 — steering the proposal

### 1. Name the retention profile that fits a ledger entry, and make re-derivation a contract

The proposal's `InspectionBundle` holds snapshots, compiled contents, turns and requests, and says
export "preserves all referenced … records required by the selected retention profile" without
naming the profiles. The consumers in this repo need one specific profile, and they need it to be
small: an oracle ledger entry (OR3), a live ledger config (LV4), a trace stage's inline `data`
(CH5), a slot in the page global. Propose a named **semantic profile**: the `SemanticSnapshot`,
the compile options and selection, the compiler version, and the content fingerprint — and
nothing emitted. Then state the contract that makes it enough: given a snapshot, the options and
the recorded compiler version, `compilePrompt` reproduces the `CompiledPrompt` exactly, or
reports a version mismatch as a diagnostic. The proposal already has `compiler.version`,
`optionsFingerprint` and determinism "given equal inputs and versions"; this names the promise the
stores will lean on. A compilation cache is then an optimization nobody has to design for now.

The complementary record is the **wire profile**: at the send boundary, the content fingerprint
plus the exact string (or JSON) that left, so renderer drift is detectable by recompiling the
semantic record and comparing. That is the "just in case the final renderer has an issue" check,
and it is the only place a rendered string needs storing.

### 2. Session-state conditionals must become recorded decisions

The largest gap between the proposal and the sites is pattern 10 of the survey: content chosen by
the session's state. The oracle resolver branches on `reason` (start, reconnect, refresh), turn
and start counts and usage (OR3, OR4); the live composer branches on the delegation backend (LV4)
and on first start versus continuation (LV5); the channel preamble branches on whether the page
is an aiui app and on the CDP alignment state (CH1), on whether any transcript was a contribution
(CH2), and on whether a notice fired before (CH8, CH9); the delegators branch on whether a task
has already spoken (LV7). The proposal offers `Choice` with a named static selection and D2's
synchronous composition, under which an author's `if` runs before the snapshot and leaves no
trace.

Propose two things. First, a **context record**: the facts a composition may read (`reason`,
`turns`, `backend`, `cdp`, `hasSpeech`, …) are passed in as a typed, serializable value and
captured into the snapshot as origins, so the inspector can say which facts the composition saw.
Second, a `Case` (or `Choice` with a selector) whose branch is chosen at compile time from the
context record, so the decision lands in `decisions[]` with the fact that decided it. Author-side
`if`s stay legal — nothing can forbid them — but the guidance for this repo should be that a
branch on session state is a `Case`, because a vanished branch is exactly what one cannot debug
after the fact.

### 3. The tool document is first-class content with several projections

Pattern 6 is the most repeated shape in the repo: one tool document (name, description, usage,
kind, group, schema, kit brief) rendered four ways — a markdown brief for the oracle and live
(VZ1 through OR3, LV4, LV9, LV11), JSON for Claude Code (CH11), a first-sentence capability list
(LV3), and vendor tool arrays that strip `usage` (OR6, LV12). The proposal says tool declarations
and capability prose "derive from one immutable tool snapshot" and that a `ToolBrief` ties them.
Steer that into a concrete core artifact: a `ToolSnapshot` with its own fingerprint and an origin
naming where it came from (a page registry namespace at a hash), and **projection components**
that are ordinary prompt values over it — `<ToolBrief>` with the read/write/group structure,
`<CapabilityList>` with the first-sentence rule — plus the vendor array as a request contribution
whose origin is the same snapshot. The inspector can then show that a tool's schema in the
request and its usage sentence in the instructions came from one declaration.

Two behaviours of the current renderer must become recorded operations rather than silent
rules: `maxChars` dropping usage lines longest-first (VZ1), and the 5.9 KB truncation that made
LV3 exist. Today the tool log's "as rendered" view (VZ11) can differ from what was sent because
it does not apply them; under the toolkit both are budget decisions with a record.

### 4. Markers, sidecars and the textual reference to an asset

The Claude Code vocabulary (LP4–LP10, IC5) is bracket markers with structured fields, followed
by XML sidecars. `Xml` covers the sidecars. The markers need a component pattern or a `Marker`
node whose fields are origins: a shot marker's path points at an asset, a code-selection marker's
location at a source site, a tab marker's attributes at a captured tab record. The important
inspector affordance is that clicking the marker reaches the captured thing.

This collides with one line of the proposal: `Image` is "atomic asset placement; no synthetic
image-placeholder text". The Claude Code session never receives bytes; it receives a path
(`[screenshot located at …]`) and reads the file itself. The proposal already admits "media
inside XML requires a declared textual reference policy". Generalize that: an **asset reference
policy** per adapter (inline media, a path, a URL, a caption) that is a recorded derivation from
the asset's identity, so the path in the text and the asset in the bundle stay linked, and the
same composition can lower to a Responses request with inline media and to a channel notification
with a path.

### 5. Elision and caps are selections, not renderer details

Pattern 13 lists caps buried in renderers: 8 elements and 4 cells in a screenshot sidecar (LP5),
240 characters then a `(N lines)` header and elision past 50 lines (LP8), 160-character clips
(CH14), 1000 characters for the summarizer (CH6), the 6000-token reseed (LV5), 500-token append
chunks (LV6), `maxChars` (VZ1). D9 says explicit selection first. Propose a standard `Elide`
primitive — by lines, characters, items or an estimator's tokens, with the marker text it emits
(`*-omitted`, `(N lines)`, `(clipped)`) owned by the elision operation as generated syntax — so
what was cut is in `decisions[]` and the marker is attributed, not authored prose.

### 6. Realtime sessions need session operations in the bundle

The proposal's turn and history model is request-shaped. Two of the repo's three main consumers
are sessions: the oracle replaces its instructions with `session.update` (OR4), sends
per-response instructions for the greeting (OR5), and injects text and images mid-session (OR8);
the live session seeds, then appends commentary, thinking and instructions (LV6). The proposal
rightly says a replacement or append "must be a host session operation with its own captured
record". Give that record a schema in the bundle — a `SessionOperation` naming the operation,
the compiled content it carried and when — so a realtime session's instruction history is a
sequence of compiled prompts, each with its semantic record, instead of the current
`config.sent.instructions` string with drift detection by text comparison. Then OR4's
"send only when the text changed" becomes a fingerprint comparison, which is both cheaper and
honest about what changed.

### 7. The lowering pipeline's IR is a semantic input, and its spans are a mapping

`composeIntent` already produces an explicit IR (`ComposedItem[]`) and `renderPrompt` emits
offset-annotated spans (LP1–LP3) that the trace-ui and the client's prompt view consume. This is
the one place the repo already does what the proposal wants, in a bespoke shape. Steer the
proposal's `Origin` to include a **captured event** origin (an intent-log event id, a capture
region, a selection snapshot), so a shot marker's origin is the event that captured it, and the
contributions map can replace `PromptSpan` for the hero view. The migration (part 2) depends on
the toolkit accepting opaque, pre-rendered text with lineage for the parts that move last; the
proposal allows "import its output as opaque text/parts with lineage" — keep that door open and
make the lineage cheap to write.

### 8. The JSX dialect routing will meet two plugins in every app here

Every app in this repo runs `aiui()` then `solid()` over all TSX. The aiui source locator admits
files by a sniff (the factory-sniff proposal) and stamps JSX with `data-source-loc`; a
`.prompt.tsx` file containing `<Section>` would be admitted, stamped, and broken. The proposal
says prompt TSX "must be excluded from Solid's compiler and from the existing aiui DOM-locator
pass" — correct, and it needs an owner on both sides: an explicit `*.prompt.tsx` exclude in the
locator (a one-line change in `aiui-source-processor`, mine to make when the convention lands)
and in `vite-plugin-solid`'s filter. Decide the convention early so the two excludes and the
`jsxImportSource` pragma agree, and add a packed-consumer example that has both plugins.

### 9. Where structured prompts will live on the page

The owner's principle applied to this repo's plumbing. Three stores exist today: the oracle and
live in-memory ledgers (final strings), the on-disk trace stages (`data?: unknown` inline, files
for blobs), and the page global `window.__AIUI__` (tools, a call ledger). Propose, as a later
`aiui` adapter outside the foundation (D1 holds): a `__AIUI__.prompts` ledger holding semantic
records for every prompt the page composed, keyed by consumer and fingerprint, that the dock's
folds and the page tool log read and render through the inspector's views; the oracle and live
ledgers reference entries there; a trace stage kind `prompt` carries the same record inline. The
foundation's part is only item 1: a record small enough to put there, and a `rehydrate` that
recompiles it and diffs against the stored fingerprint.

### 10. Adapters are consumer-specific — make the framework flexible, ship a few as utilities

Decided with the owner, 2026-10-09. The consumers in this repo do not fit one request shape:
a Realtime session over WebRTC or WebSocket with instruction replacement, per-response
instructions and mid-session appends (OR4–OR8, LV6); a channel notification to a Claude Code
session that carries a path to an image rather than the image (CH8, LP4); a stateless Responses
loop (LV9); a nested Claude Agent SDK query where later delegations are continuations (LV11);
and a linter session on Gemini Live (CH13). Adapters will therefore live with their consumers,
and the toolkit's job is the **adapter framework**: a contract flexible enough for transports and
protocols it did not anticipate — streams, sockets, sessions that mutate, hosts that deliver
assets by reference — with a few **reference adapters that are also utilities** (the
Responses-style one, a messages/content-block one) rather than examples only. The capability
profile, the lowering result (payload, map, status), the session-operation record and the
asset-reference policy are the parts the framework must own; what a given adapter does with a
socket is the consumer's. An adapter written here that turns out general — the Realtime one is
the likely case — gets upstreamed into the toolkit later.

### 11. Smaller notes

- Content fingerprints must be cheap and exclude telemetry (the proposal says so); the oracle
  recomposes on every completed turn (OR4) and must not pay a full compile to learn nothing
  changed. Fingerprint the snapshot, not the emission.
- `Choice` names are global per compile (duplicate names throw in the spike); the oracle's
  resolver context and the live slots will want the same name in several reused fragments.
  Scope names to the placement, as labels are.
- The spike's single `Node` type with optional fields is noted as a non-contract; the survey
  confirms the consumers want discriminated unions — the tool projections and markers are new
  kinds, not new optional fields.
- The oracle speaks the Realtime API (`session.update`, `conversation.item.create`), which is
  neither Responses nor messages; it is the adapter with session operations (item 6) and will
  be written beside the oracle first (item 10).

## Part 2 — staging the migration

### Decisions taken 2026-10-09

- The corpus is a **baseline, not a contract**: a migrated site may differ from today's output
  with a reviewed diff.
- Adapters are consumer-specific (item 10); the toolkit owns the framework and a few utility
  adapters.
- The `.prompt.tsx` routing (item 8) is the toolkit agent's **first task**, settled before any
  app-side composition.
- The pre-work below is done in this repo now, by the sites' owner; `render-audit.mts` retires
  in favour of the corpus.

### What can be done now, before the toolkit exists

These de-risk the move and cost little. None depends on the toolkit's API.

1. **Golden corpora per site.** The survey's gap list ends with "no target that reproduces an
   existing site's output byte for byte". Record one now: for each site family, fixtures of
   inputs and the exact string produced today (the lowering pipeline already has fixture tests;
   the oracle weave, the live composer, the tool brief and the delegation messages do not). The
   toolkit version of a site must reproduce the corpus or ship a reviewed diff. This replaces
   `render-audit.mts`, which cannot run (it imports a removed function); retire it with the
   corpus.
2. **One projection of the page registry.** IC2 is a second copy of OR11; it dropped `group`
   until today. Make the panel use `toolsFromAiuiRegistry` and delete its own copy. One fewer
   site, one fewer way for the oracle's two hosts to disagree.
3. **A `ToolSnapshot` value in aiui-viz.** The four `renderToolBrief` callers already flatten to
   `{ ns: "app", brief, tools }`. Give that shape a name, a fingerprint and an origin now, and have
   OR3, LV4, LV9 and LV11 pass it. When `<ToolBrief>` exists, the input is ready.
4. **Record what is unrecorded.** The Responses and Claude delegator prompts (LV9, LV11), the
   summarizer input (CH6) and the session notices (CH8, CH9) leave no record. Add ledger or trace
   entries with the exact text now; they become the "before" half of every migration diff.
5. **Make the vocabulary single-sourced where it is prose.** CH7's `INSTRUCTIONS` teaches the
   marker grammar by hand; CH13 and OR1 are mirrored into docs by hand. Until the toolkit can
   generate them, a test that asserts the prose mentions every marker the renderers emit is a
   cheap guard.

### The order once the toolkit exists

Each stage is byte-identical first (the corpus), then improved with recorded diffs.

- **Stage 1 — the shared component.** `renderToolBrief` (VZ1) becomes `<ToolBrief>` over a
  `ToolSnapshot`, with read/write/group structure, the failure line, and `maxChars` as a recorded
  elision. Its four callers consume compiled parts. The oracle ledger's `config` entry stores the
  semantic record beside what was sent. One site, four consumers, the largest coverage per line
  changed.
  **Done 2026-10-09.** aiui-viz's `tool-brief.ts` is a layer over the toolkit: `toolSnapshot`
  returns the toolkit's snapshot, `toolBrief` its `ToolBrief` node, `renderToolBrief` the node's
  compiled text (the corpus is byte-identical, no `-u`), `instructionsWithToolBrief` the
  `Prompt[preface, ToolBrief]` every consumer composes, and `renderPrompt` the snapshot → rehydrate
  → text step that proves the stored record reproduces the wire. The oracle's woven text and the
  live backends' task prompts enter as `importText` (opaque, with an origin — stage 2 replaces
  them); the oracle `config` entry and the live `prompt` entries carry `prompt: SemanticRecord`.
  The Claude delegation message still wraps the brief's text in its string template — its
  `<delegation>` element is stage 2's `Xml`, where the once-only escaping is a reviewed diff.
  Not yet: tool schemas in the snapshot (`inputSchema` is accepted but no consumer passes it, so
  the fingerprint still covers exactly what the brief renders), and an `origin` on the consumers'
  snapshots (the toolkit folds `origin` into the fingerprint, so two sites naming different
  origins would not share one for the same document — raised with the toolkit).
  **2026-10-10:** the toolkit split into core, inspector and vite packages and took `origin` out
  of the tool fingerprint. The stored records got their first reader: aiui-viz's
  `site/prompt-record` mounts the inspector's `PromptPreview` (loaded on demand, its styles
  injected from the inspector's string export) on the oracle's `config` entries and the live
  ledger's `prompt` entries.
- **Stage 2 — the oracle, then live.** The persona and slot weaver (OR1–OR3), the resolver
  context as a context record with `Case` decisions (OR4), the greeting as a per-response session
  operation (OR5), the panel and dock recipes (IC1, DK2) as two compositions over one component.
  Then the live composer (LV1–LV4), the reseed as a history binding with its token budget as an
  elision (LV5), the appends as session operations (LV6), the backend prompt and the delegation
  messages (LV8–LV11) with the `delegation` XML element and the transcript rendering. This is
  where the Realtime adapter and session operations (item 6) get built.
  **Oracle half done 2026-10-10.** `instructionsPrompt` is the weave as nodes (persona, keyed
  slots, heading and value as separate contributions); the resolver's facts ride as the record's
  context; the greeting is a `respond` session operation under the toolkit's `openai-realtime/1`
  profile; every update that carries instructions is lowered by the oracle-owned adapter
  `aiui-oracle/realtime-session@1` (instructions bound, audio/tools/limits as parameters — the
  toolkit agent's guidance, since `verifyWire` compares the whole event) and captured as it leaves;
  the `config`, `live` and greeting entries carry `prompt`/`operation`/`wire`. Corpus byte-identical.
  Not done: the panel and the dock still author `context` as two different strings (a canonical
  `<tab …/>` record versus a prose sentence); unifying them changes the dock's bytes, so it waits
  for a reviewed diff. No oracle-internal `Case` exists yet because nothing in the oracle's own
  text branches on a fact — the facts are recorded so an app's resolver can.
  **Live half done 2026-10-10** (a forked agent, reconciled). `livePromptValue` is the composer as
  keyed nodes with the capability list as the toolkit's `CapabilityList` projection;
  `backendPromptValue` keeps its `##` headings as authored lines (a root `Section` renders `#`);
  `requestMessageValue` and `delegationMessageValue` are prompts whose facts (an empty transcript,
  no tools, no recent lines) are recorded `Case`s, and the `<delegation>` element is an `Xml`
  node — escaping once, which the corpus never exercised, so no diff; the connect config is a
  `connect` operation of `aiui-live/session@1` (instructions, hosted-backend instructions and the
  re-seed preface bound; model, audio, delegation, hosted tool schemas and the seed history as
  parameters) whose payload IS the object the transport receives; each append is a
  `sessionOperation` under `live-session/1`. Three deliberate departures from the plan: the re-seed
  is NOT an `Elide` (the toolkit keeps the first N, the re-seed keeps the newest lines within a
  token budget the toolkit cannot count — the cut is recorded in the operation's parameters);
  append chunking stays host-side, one operation per chunk; the Responses HTTP request is not an
  operation (the `openai-responses/1` utility omits `tool_choice`, `reasoning` and `store`, so it
  would need its own adapter — later). Questions for the toolkit: a keep-the-last-N elision mode,
  and parameters on `sessionOperation` (a chunk index).
- **Stage 3 — the lowering pipeline and the channel.** `ComposedItem[]` becomes the semantic
  input: shots as markers with asset-reference policies and sidecars, selections as text plus
  XML, navigation and tab switches as markers, corrections as `Case`. The contributions map
  replaces `PromptSpan` for the trace-ui hero and the client's prompt view. The preamble sections
  (CH1) and the fin-time join (CH2) become one `Prompt` with `Case`s on the hello facts and the
  turn's facts, pre-warmed as a snapshot rather than as strings. The summarizer (CH6) reads the
  semantic graph and selects, instead of regex-stripping the rendered text. `INSTRUCTIONS` (CH7)
  is generated from the same marker definitions. The trace stage kind `prompt` carries the
  record.
- **Stage 4 — the page-authored text.** The standard tools' fixed descriptions and usage (VZ5),
  the cross-filter and sql usage rebuilt from runtime state (VZ7, VZ8), the demos' briefs. These
  are short strings with a clear owner; they move last, and only to gain the `ToolSnapshot`
  origin and fingerprint. The hand-mirrored personas in docs become generated appendices.

### Risks to decide early

- **Byte-identical or better.** Some current output is accidental (the dock's `context` sentence
  differs from the panel's tab record; the `ns_` prefix appears only with several namespaces).
  Decide per site whether the corpus is a contract or a baseline; the default should be baseline
  with a reviewed diff.
- **Two hosts for one oracle.** The panel and the dock compose the oracle differently today
  (IC1 versus DK2). Stage 2 should end with one composition and two context records.
- **The Realtime adapter.** It is the first consumer with session operations; if it slips, the
  oracle keeps storing strings. Schedule it with stage 2, not after.
- **The routing of `.prompt.tsx`** (item 8) blocks every app-side composition. Settle it before
  stage 1 lands in any demo.
