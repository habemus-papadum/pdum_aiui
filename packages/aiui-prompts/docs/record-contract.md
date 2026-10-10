# Semantic record and re-derivation contract

This is the implemented foundation contract. It incorporates the
[consumer review](../../../docs/proposals/structured-prompts-review.md) and supersedes preliminary
API shapes in the larger architecture proposal. The public TypeScript definitions remain the exact
field-level authority. Static version-1 fixtures for [content](../test/fixtures/semantic-v1.json),
[operations](../test/fixtures/operation-v1.json), and [captured wire payloads](../test/fixtures/wire-v1.json)
are read directly by the compatibility suite; tests do not regenerate them.

## Retention and identity

There are three distinct retained objects:

1. `SemanticRecord`: content definitions and placements, captured context facts, selection options,
   recorded decisions, schema version, compiler identity, and fingerprint. No emitted-text cache, maps,
   closures, preview DOM, environment lookups, token cache, or asset bytes.
2. `OperationRecord`: session action, channel push, Responses delegation, or a versioned consumer
   action; deduplicated semantic records addressed by fingerprint; bindings and captured parameters,
   with explicit history and optional tool snapshot in the Responses utility.
3. `WireRecord`: exact payload captured by the host at a real delivery boundary, semantic operation
   fingerprint, target, asset bindings, lowerer identity, and capture metadata. This is the narrow
   place where storing the rendered payload is intentional.

Compilation and prepared delivery are derived artifacts. The inspector can reconstruct them from
retained records; the ledger does not have to persist them. The package deliberately supplies no
new ledger database, aiui cell, transport, or agent loop. Existing stores adopt these JSON values.

All records are plain JSON. Capture defensively copies and freezes inputs; callers retain ownership
of their original objects. The JSON boundary rejects accessors without invoking them, functions,
undefined fields, sparse arrays, cycles, symbols, nonfinite numbers, and nonplain objects. Object
keys are sorted recursively; array order is preserved. SHA-256 covers canonical UTF-8 JSON. These
fingerprints detect content changes, not authorship or authenticity. Negative zero normalizes to
JSON zero. Scientific formatting belongs in explicitly authored strings.

Definition identity means shared immutable authoring data; a reused object is stored once in the
content graph. Placement adds a local key, label, and provenance. Compilation expands occurrences
in context. An occurrence ID is a root-relative placement path; a key is scoped to siblings, never
a global ID. Duplicate sibling keys fail. A different root key is not inferred to be the same
cross-revision occurrence merely because both roots have address `o`.

Text part IDs and output offsets belong to one compiled artifact. Neither is a durable source
location or an automatic correspondence between revisions. Record fingerprints include context,
compiler, provenance, and decisions: unchanged emitted text does not imply the same semantic record.

## Versions and replay

Every durable family has `kind` and `schemaVersion: 1` from its first implementation. Semantic
records name compiler `{ name: "aiui-prompts", version: "1.0.0" }`. The semantic compiler version is
independent of the repository's package version. The initial pure lowerer is
`aiui-prompts-delivery/1.0.0`; individual targets also have versioned protocol names.

`parseRecord` validates shape, supported schema, compiler identity, graph references, keys, cycles,
selection addresses, fingerprint, and consistency of recorded decisions with captured facts.
`rehydrate` validates then derives with the recorded compiler. No author code runs and no provider,
file, asset, or current session state is fetched. Equal valid records under this compiler produce
identical parts, occurrence metadata, contribution maps, semantic regions, decisions, and diagnostics.
Compilation may also reject invalid semantic combinations with a stable diagnostic; schema validity
alone does not mean every selected composition can render. A URL's bytes are outside this promise:
reproducing an asset descriptor is not verifying its bytes.

Unknown schemas or compiler/lowerer versions fail explicitly. They are never interpreted using
latest behavior. Only version 1 is installed; there is no fake migration from an older production
format and no conversion of spike fixture data. Future changes must either preserve the version-1
semantics and compatibility fixtures, or introduce a separately versioned implementation/read path.
Keep old readers/compiler implementations available for retained ledger records. A migration must
be explicit, retain the original fingerprint, and test both old and migrated derivations. Dependency
updates affecting emitted prompt text need the same compatibility review as compiler changes;
preview-only changes do not change semantic compilation.

`serializeRecord` and `serializeOperation` validate before returning canonical JSON. Wire capture is
an explicit host action; a prepared payload is never proof of sending. `verifyWire` validates its
version and operation reference, lowers again with recorded bindings, and compares canonical JSON.
It checks the decoded payload, not JSON key ordering or the transport's literal byte encoding.

The host must retain the exact asset binding used at delivery, especially if an upload ID or URL
changes. A known asset digest must agree with its binding. No built-in upload or URL fetch is hidden
inside rehydration. The host controls compiler availability, durable storage, source snapshots,
asset lifetime, model selection, and actual delivery.

## Recorded context decisions

`Case` contains a name, ordered `{ when, value }` branches, and fallback content. Predicates are
JSON data: `eq`, `ne`, numeric comparisons, `exists`, `all`, `any`, and `not`. Paths address own
properties through dot-separated context segments. Missing is distinguishable from a present null.
Equality compares canonical JSON; it does not coerce numbers and strings. A missing fact fails a
value comparison, including `ne`. Predicates have no callbacks, clock, random value, or network.

The first matching branch wins. Capture records its index (or `fallback`) and every fact observed
while evaluating branches through the selected branch. Boolean predicate groups evaluate all their
children so their evidence is complete; later Case branches are not evaluated. All authored branch
contents remain in the semantic graph, including inactive alternatives. Decision derivation does
not emit strings. Validation recomputes the decision trace to detect disagreement with the context.

`Choice` is an independently selected authored alternative: full, optional short, or omit. A plain
selector addresses that name across placements; `occurrence:name` addresses one placement. Scoped
selection wins. Unknown names and invalid paths fail instead of silently doing nothing. A declared
choice in an inactive branch remains addressable, so an inner selection can survive omitting an
outer choice. Full and short content remain available for later analysis.

`withRecordOptions` returns a new record, captured facts/options, decisions, and fingerprint.
Use that record when retaining an accepted optimization or changed session context. The convenience
`compilePrompt(record, options)` returns an artifact only; it is not a replacement stored record.

Ordinary author-side TypeScript conditionals remain legal for static composition. A branch based
on session reason, start count, backend, browser alignment, usage, or prior speech should use `Case`.
Otherwise its rejected alternative and reason are already gone when capture starts. Required dynamic
facts must first be acquired by the host and supplied as captured JSON.

## Composition and compilation

The core supports prompt/group/paragraph/text, contextual sections, ordered joins, math, XML,
images, explicit uses, Case/Choice, markers, elision, and tool projections. JSX executes synchronous
components to produce these values. Bare numeric/boolean-true/object/promise children are rejected;
null and false represent absence. A component may use ordinary typed props and helper functions.
No component code or function source is serialized.

Capture produces a validated immutable graph. Resolution applies recorded decisions and contextual
heading levels, then emits text/image atoms with owner identity. The emitter coalesces neighboring
text into parts while retaining exact contribution intervals and semantic regions. There is no
second pass that searches emitted strings to guess where they came from.

- Prompt and section children use blank-line separators; Group/Paragraph concatenate. Join controls
  an exact separator and skips empty children. Empty sections disappear unless `keepEmpty` is set.
- Section depth comes from global placement; depth beyond Markdown's six levels is an error. Titles
  are plain text escaped for Markdown. Reusing a section never mutates its definition.
- Math carries raw TeX, inline/display mode, and one complete semantic scope. It may concatenate
  text from several contributors. Its delimiter syntax belongs to the math owner. Illegal block or
  media nesting inside TeX fails; no attribution command is inserted into the equation.
- XML validates names and XML characters, sorts attributes deterministically, and escapes text and
  attribute contexts exactly once. Markdown sections, tool briefs, transcript text, and math may be
  composed inside the wrapper; nested XML stays structural. Escaping happens at emission, after
  text selection, so elision cannot cut an encoded entity in half. Media inside XML
  requires an explicitly authored textual projection; it is not silently flattened.
- Images are atomic ordered parts with stable host asset descriptors. They do not become synthetic
  text until a particular consumer explicitly requests a textual representation.
- Marker fields are JSON data; generated marker syntax retains owner attribution. Optional child
  content allows a structured XML tab record inside brackets while preserving its own contributions.
  Atomic media cannot be hidden inside a textual marker. App-specific vocabulary remains ordinary
  components over markers/XML/Text; the foundation does not hard-code the old bracket grammar.
- Elide records unit, limit, marker, and original content. Supported units are Unicode code points,
  logical lines, and authored items. It does not bisect atomic math/XML/image content. Its derived
  selection/counts and generated marker ownership are visible in the compiled artifact.

Tool declarations are immutable `ToolSnapshot` JSON: namespace/kit brief plus each tool's name,
description, usage, kind, group, and optional input schema. Execution callbacks remain with the host.
ToolBrief, CapabilityList, ToolJson, and provider tool schemas derive from the same fingerprint.
Usage removal is a longest-usage-first policy with recorded before/after counts and removed keys;
mandatory names/descriptions and the failure instruction remain even when they exceed `maxChars`.
A capability projection records its first-sentence rule. These derived decisions are recomputable
from retained declarations and policies; the semantic record stores neither duplicate projection
strings nor derived character counts. Namespace collisions require explicit qualification.

Graph depth and expanded occurrences have explicit bounds. Compilation is synchronous and pure;
asynchronous acquisition happens before capture. Streaming, arbitrary renderer extensions, and
provider tokenization are not hidden behind these primitives.

## Mappings and provenance

A `Contribution` owns exactly one emitted interval or atomic image. Text offsets are half-open
UTF-16 code units within a named output part. Contributions partition each part without overlaps or
gaps and identify authored, generated, or escaped material. This supports exact exclusive accounting
without counting every ancestor as a second contribution.

`mappingIndex` answers part-range→contributors/owner chain and occurrence→output. Source construction,
placement, nested provenance lineage, and field-level tool projection origins are separate metadata.
Output ownership remains exact when source metadata is unavailable or only identifies an owner.
An image has an atomic address; text coordinates on images are invalid.

`importText({ text, origin, spans })` is the migration seam for an existing renderer or captured IR.
It preserves exact text and optional disjoint UTF-16 owner spans, fills uncovered intervals with
the parent origin, and retains captured event/asset metadata. Invalid ranges, overlaps, and surrogate
splits fail. The resulting ordinary Group/Text graph contains input text with explicit imported
lineage; it does not pretend that legacy markup was structurally authored or that its source map
is character-exact. No legacy renderer or application dependency is imported.

Optional source instrumentation records relative file, SHA-256 revision, UTF-16 source span,
construction/interpolation role, and owner precision. It must preserve output, item boundaries,
keys, and author evaluation order. Source resolution is a host service that checks the revision;
stale source must not be shown as exact. Imported external content may have a host origin instead
of a code location. Automatic capture currently covers JSX sites, not arbitrary snapshot/compile
call sites or exact character correspondences through JavaScript evaluation.

Delivery maps address decoded payload fields through arrays of JSON path segments. They connect
text fields or channel text subranges back to content parts, and media fields/text references back
to asset identity. Tool schema entries point to the same tool snapshot. They do not currently map
all transport framing fields or JSON-encoded escape byte offsets. When composing the channel text,
separator/reference insertion participates in the derived mapping; it never changes stored content.

## Three consumers and separate history

`OperationRecord.operation` is a discriminated union, not a universal request-shaped provider:

| Operation / target | Derived delivery |
| --- | --- |
| Session replace / `openai-realtime/1` | `session.update` with complete instruction replacement |
| Session input / `openai-realtime/1` | `conversation.item.create`, ordered input text/images |
| Session respond / `openai-realtime/1` | `response.create` with per-response instructions |
| Session append / `live-session/1` | Repository extensions for instructions, thinking, and commentary append |
| Channel push / `claude-channel/1` | `notifications/claude/channel`, text content plus string metadata |
| Response / `openai-responses/1` | Instructions, current messages, history, tools, and optional output schema |

Targets reject unsupported combinations. Public Realtime is not assigned the repository's custom
append protocol. Text instruction fields reject undeclared media coercion. Channel assets require
path, URL, or caption bindings; each textual representation has a recorded decision and mapping.
Responses assets support host-resolved URL or uploaded-file bindings; Realtime image input requires
host-resolved PNG/JPEG base64 data URIs. Authored assistant examples lower as text messages; complete
assistant output items, including annotations and phase, belong to opaque replay. These are pure profiles,
not SDK clients. The model and session connection stay with the host.

History is `none`, opaque provider items under a named protocol, or a remote conversation/previous
response reference. Current messages have unique keys and explicit user/assistant roles. Historical
items retain their order and JSON data and are never silently converted to role/content pairs.
Server references are not replayed as local messages. Content optimization has no access to rewrite
history; a caller estimating a complete request must explicitly account for the cost it knows and
report unknown costs it cannot measure.

Protocol references:
[Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events)
and [Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create).
The separate live append profile is based on the repository's protocol, not inferred vendor support.

## Consumer-owned adapters

The three consumer families motivate the initial utility profiles, not a closed list of protocols.
`consumerOperation` captures `{ adapter: { name, version }, action, bindings, params }`. Bindings have
unique local keys and refer to deduplicated semantic records. Parameters are plain JSON acquired by
the host. An operation can have zero content bindings, for example a session-control action.

A consumer supplies its own `ConsumerAdapter` implementation alongside an immutable identity and
capability profile. The profile declares accepted `actions`, `content` part kinds, and `assets`
representation kinds. The framework checks those declarations, validates required image bindings
and known digests, and then invokes `lower` with frozen operation parameters, target options,
compiled bindings, and prepared assets. The callback can reject narrower protocol-specific
combinations with an explicit diagnostic. It performs no transport or acquisition; all inputs
needed for replay belong in retained parameters, options, content, or asset bindings.

`lower` returns `{ payload, mappings, decisions }`. A payload can be any plain JSON value, including
an array of socket events. The framework owns the prepared status and validates/copies the result;
an adapter cannot mark itself sent. Delivery maps must address existing payload paths and actual
record bindings. A `copy` map names one whole text part and matching UTF-16 destination bounds;
an `asset-reference` map names an image part. Generated fields may identify a binding without
claiming character correspondence. These checks validate declared precision, not map completeness;
consumer tests must cover their protocol framing and all required attribution.

`lowerOperation(operation, target, assets, [adapter])` and `verifyWire(operation, wire, [adapter])`
resolve exactly the recorded adapter name and version. Missing, mismatched, and duplicate
implementations fail explicitly. Identity versions cover both the capability profile and lowering
semantics; consumers must retain old versions for stored records. Callbacks and registries are
never serialized, globally registered, or silently replaced with newer code. Wire replay checks the
captured payload against this derivation; it does not contact the original session or replay events.

The [adapter contract tests](../src/adapters.test.ts) include a consumer-owned socket event batch,
control actions without content, version failures, capability refusal, image-reference policy,
immutable JSON boundaries, and malformed attribution. Transport integration belongs downstream.

## Analysis and inspector

`measurePrompt` reports exact UTF-16 units, code points, UTF-8 bytes, images, and exclusive owner
costs. Tokens remain unknown without an explicit estimator. `comparePrompts` keeps before/after
artifacts independent, matches compatible scoped keys conservatively, and computes bounded
prefix/suffix text edits with surrogate-safe boundaries. Unversioned images have unknown byte
identity. Positional output comparison does not claim to infer moves.

`optimizePrompt` is a bounded reference enumeration over declared full/short/omit variants. It
returns a new record and candidate ledger. Short is considered only where authored. Caller order
expresses variant preference; the default prefers full before short before omit. A fit is measured
again after recompilation. Results distinguish fit, infeasible within the declared candidate space,
search exhaustion, and unknown cost. Estimator errors or mismatched unit/scope are errors, never
false proofs of infeasibility. Estimated fits remain explicitly estimated. The default character
budget measures text only; it
is not a token-window guarantee for a multimodal request. There is no automatic
summarization, truncation of history, semantic-equivalence claim, or built-in tokenizer.

The inspector parses each complete contiguous text part using original-source Markdown positions,
GFM, and math extensions. It renders an owned DOM and KaTeX. Clicking raw/preview/tree regions uses
contribution mappings; preview precision is a block or complete equation. Folds are a view state:
raw text may hide exactly one contributor while a shared equation/table remains complete and marked
partly folded. Canonical copy/export remains unchanged. Rich preview shows images inline in part
order, with atomic-owner selection and coordinated folds; raw output retains hover/pinned popups.
Malformed imports preserve the last validated view with diagnostics. Source navigation callbacks
receive recorded origins. Comparison uses two independent views. See [inspector details](../inspector/README.md).
XML tags remain literal. If the Markdown parser recognizes an equation wholly inside a compiler
XML region, the preview decodes one text-escaping layer for KaTeX while preserving the encoded
output range. This is whole-equation attribution, not a general nested XML renderer or an exact
decoded-character map.

The first test line uses jsdom with the real compiler, positional parser, KaTeX, DOM events, and
mounted views. No hand-authored fake maps stand in for compiler behavior. Browser checks cover real
fonts/math layout, hover reachability, image loading, and other platform behavior. Ordinary semantic
logic, fold state, error recovery, canonical copying, and listener disposal stay in fast DOM tests.

## Delivered boundary and next work

This first implementation establishes records/readback, recorded decisions, composition/compilation,
owned JSX routing and optional source owners, tool projections, consumer-owned adapters and utility profiles, mappings,
analysis/search, and an actual record-driven inspector. The private experiments remain unchanged.
Tests cover core replay and malformed records, static schema compatibility, mounted UI, consumer
payloads, actual Solid routing, source-transform parity, and production bundling.

Remaining roadmap work is explicit: migrate actual callers against the colleague's golden corpus;
add versioned compatibility readers as schemas evolve; complete request-field attribution and
host transport capture integration; add tokenizer/evaluation services, richer diff algorithms,
audio/video/file node protocols, call-site source capture, DOM selection mappings, scroll sync,
virtualization, and archived-source navigation. These should extend the established JSON and mapping
contracts, with a schema/compiler decision whenever retained meaning or emitted output changes.
