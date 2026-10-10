# Starting the first consumer migration

The foundation is ready for an initial consumer port. Begin with the shared tool brief, following
the [consumer review's migration order](../../../docs/proposals/structured-prompts-review.md).
The packages are public and their authoring APIs can still evolve with integration feedback.
No version has been published yet. This refactoring deliberately removes the earlier entry points;
the stored schema/compiler contract has fixtures defining the first release's behavior.

1. Build the site's composition with this package's own nodes and tool declarations. A boundary
   conversion from the consumer's current input shape is appropriate; the foundation must not
   import the consumer's renderer, state, transport, or execution callbacks.
2. Capture acquired facts in `snapshot` context and express session-dependent choices with `Case`.
   Use `ToolBrief`'s budget policy for usage removal, rather than truncating the emitted string.
3. Store `serializeRecord(record)` in the consumer's ledger and test loading it through `parseRecord`
   and `rehydrate`. Replaying a record must not execute author code or consult current session state.
4. Compare the port with the site's baseline corpus and review meaningful differences. The corpus
   documents current output; it does not require preserving accidental whitespace, spelling, or
   renderer behavior. Add consumer tests for the intended new behavior.
5. Keep sending and asset preparation with the consumer. Use a utility lowerer where it fits, or
   implement the versioned `ConsumerAdapter` contract. Capture the actual payload at the transport
   boundary if wire verification is needed. A prepared payload alone is not a sent receipt.

The [record contract](record-contract.md) is the implemented API guide; the larger architecture
proposal also describes future work. Before adding `.prompt.tsx` to a Solid application, apply the
[routing configuration](jsx-routing.md). UI theming, inline preview behavior, and cost badges are
independent of the stored records and do not block this migration.

Changes from consumers are welcome, with a focused regression test for the reported input.
Everything is pre-alpha (the owner's stance, 2026-10-10): a change that cleans the design may alter
retained meaning, decision derivation, emitted output, actions or adapter identities without a
compatibility path — update the static fixtures when the change is intended, never to make an
accidental change pass, and say in the commit what moved. Consumers adapt their own stored records.

## Package split and native Solid refactoring

Consumers should update their imports before continuing the port. This change establishes three
physical packages so a server installing prompt composition never installs a UI or build tool.
All names below use the `@habemus-papadum/` scope.

| Need | Package / entry |
| --- | --- |
| Nodes, JSX runtime, semantic JSON, compiler, tool snapshots | `aiui-prompts` |
| Accounting, contribution queries, comparison, bounded selection | `aiui-prompts/analysis` |
| Operations, history references, delivery adapters, captured wire | `aiui-prompts/operations` |
| Solid full inspector and embeddable preview | `aiui-prompts-inspector` |
| Optional viewer CSS and themes | `aiui-prompts-inspector/style.css`, `themes/aiui.css`, `themes/terminal.css` |
| Prompt JSX transform and source owners (development dependency) | `aiui-prompts-vite` |

`aiui-prompts/inspector` and `aiui-prompts/vite` are removed. Operation helpers and types are no
longer re-exported by the core root. The old private authoring and inspector spikes remain in source
control as independent reference experiments. The production workbench now runs with
`pnpm --filter @habemus-papadum/aiui-prompts-inspector dev` on port **5219**.

Core has zero third-party runtime dependencies, including no Solid, DOM, Markdown, KaTeX, Vite, or
existing aiui runtime. Applications own transport and asset access. The inspector depends on core
and the display libraries; the source plugin depends on core and its transformation utilities.
In-workspace dependencies retain the repository's source-first convention; published entry points
resolve to built JavaScript and declarations.

Tool identity now means document content: `ToolSnapshot.fingerprint` includes canonical declarations
and their schema identity, and excludes `origin`. Capturing an equal tool document at two sites
therefore shares its fingerprint. Capture provenance remains on the snapshot and in projected field
origins. The enclosing semantic or operation record's fingerprint covers that provenance. Store the
full semantic record when reproducing a particular capture matters; use the tool fingerprint to
deduplicate declarations, not to erase site-specific origins.

### Embed a preview or the full inspector

The viewer is implemented as native Solid 2 components. It shares the repository's Solid release
candidate through peer dependencies. A host component imports it using ordinary Solid JSX:

```tsx
import { PromptInspector, PromptPreview } from "@habemus-papadum/aiui-prompts-inspector";
import "@habemus-papadum/aiui-prompts-inspector/style.css";
import "katex/dist/katex.min.css";

// A small widget: Markdown/math/images initially, a raw-text toggle, and full inspection on demand.
<PromptPreview record={savedRecord} resolveAsset={asset => urls.get(asset.id)} />;

// An audit page: composition, canonical raw output, rich preview, and provenance together.
<PromptInspector record={savedRecord} onSource={origin => editor.open(origin)} />;
```

Both views share the real compiler, parser, mapping, and image behavior. Rich previews keep declared
images inline. Raw image markers open a popup near the marker, dismiss on pointer exit, and support
keyboard focus and Escape. The condensed view's full inspector shares its selection/fold state.
Styles remain optional, neutral, and customizable through inherited `--prompt-*` tokens and stable
classes. See [theming](theming.md); no aiui stylesheet or design runtime is required.

Plain DOM hosts can use `mountInspector` or `mountPreview` and call `dispose()` when removing the
widget. These wrappers mount the same Solid components; they do ship the Solid runtime. For custom
renderers, `InspectorController` from `aiui-prompts-inspector/model` remains independent of Solid. A supplied controller belongs to its
host; each mounted wrapper owns and disposes the controller it creates.

### Load records from a ledger

Pass stored semantic JSON directly. No author module, prompt function, or current session state is
needed. Operation records expose a selector for each current prompt binding, retaining message order
and instruction boundaries. Retained provider history stays opaque metadata.

```ts
import { mountInspector } from "@habemus-papadum/aiui-prompts-inspector";

const view = mountInspector(element, savedWire, {
  operation: savedOperation,
  adapters: retainedAdapterImplementations,
  resolveAsset: asset => archivedAssetUrls.get(asset.id),
});
// Later, reuse the same widget for another entry.
view.load(savedSemanticRecord);
```

A wire or prepared delivery references its operation by fingerprint, so supply the matching
operation through `operation`. The host retrieves it from storage before loading. The viewer shows
captured wire data separately from derived delivery, with an equal/different/unavailable verification
result. Missing exact custom adapter implementations leave the captured payload visible and explain
why verification is unavailable. It never chooses a newer adapter silently or sends a payload.

Prepared deliveries are derived caches, not sent receipts. Their stored maps are displayed as data;
navigation uses fresh compiler maps. The viewer compares a prepared artifact, including its mappings
and decisions, with fresh lowering. Semantic records remain the durable source of truth. Unknown
semantic schemas or compilers fail explicitly, retaining the last valid view. Hosts also own archived
source resolution: a file name alone does not establish that today's source matches a recorded revision.

### Test the port without a browser

The first line is Vitest plus jsdom, compiling actual Solid JSX with `vite-plugin-solid`. The inspector
configuration uses the repository's `solidTestDeps` and `SOLID_TEST_CONDITIONS` helpers so Solid's
signals and DOM renderer resolve to the same browser/development runtime. A DOM emulator does not
remove Solid reactivity; mixing server and browser runtime instances does.

Tests mount the production components and use real semantic records, compilers, parsers, and KaTeX.
The pre-refactor behavioral tests are retained as the reference for folds, source navigation, exact
copying, math/table partial folds, inline images, errors, comparison, and cleanup. Additional tests
exercise compact/full transitions, reactive record replacement, stable DOM identity, historical
binding selection, and adapter verification. Native Solid writes are batched; tests must settle them
before asserting an update. The DOM mounting wrappers preserve synchronous imperative controls.

Pure tests cover popup positioning independently of browser geometry. jsdom checks interaction and
cleanup, not actual font metrics or image loading. The workbench is the browser check for placement,
responsive layout, math fonts, and pointer behavior. Core packaging tests import real packed entry
points in plain Node with no DOM and compile a separate typed consumer; routing tests exercise actual
Solid and prompt dialects in one Vite application. Consumer ports should add tests at their boundary,
especially storing/reloading records and their session-state decisions, rather than mocking core.
