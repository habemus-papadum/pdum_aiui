# Structured prompts

An owned TypeScript toolkit for composing, storing, recompiling, inspecting, and lowering prompts.
The durable product is a small **semantic record**, not a rendered string or an inspection bundle.
This package is the foundation the aiui consumers migrate onto (aiui-viz's shared tool brief is
the first, with the oracle and the live delegators behind it); its runtime imports no existing
aiui package, Python code, or third-party prompt framework.

The [record contract](docs/record-contract.md) describes storage, decisions, replay, identities,
output mappings, delivery, and the supported implementation boundary. The
[architecture proposal](../../docs/proposals/structured-prompts.md) retains the larger roadmap.
The [corpus shape review](docs/corpus-shapes.md) explains how markers, sidecars, tool budgets, and
mixed XML/Markdown map to the new contracts without requiring legacy output parity.
The [adoption guide](docs/adoption.md) covers consumer migration and the package split.

## Run and inspect

From the repository root:

```sh
pnpm --filter @habemus-papadum/aiui-prompts-inspector dev
pnpm --filter @habemus-papadum/aiui-prompts test
pnpm --filter @habemus-papadum/aiui-prompts typecheck
pnpm --filter @habemus-papadum/aiui-prompts exec tsc -p tsconfig.test.json
pnpm --filter @habemus-papadum/aiui-prompts lint
pnpm --filter @habemus-papadum/aiui-prompts build
pnpm --filter @habemus-papadum/aiui-prompts-inspector build:bench
```

The workbench runs on **<http://127.0.0.1:5219>**. It uses the actual record validator, compiler,
Markdown/math preview, and delivery lowerers. Change captured session facts, inspect the recorded
branch, fold part of an equation, inspect inline images and raw-image popups, import saved JSON,
compare two records, and switch
between Realtime, live append, channel, and Responses delivery. No request is sent.

The [inspector API and behavior](../aiui-prompts-inspector/README.md) cover embedding and mapping precision.
The [styling contract](docs/theming.md) covers neutral defaults, host themes, and per-instance overrides.
Use the workbench's theme selector to compare styles without resetting selection or folds.
Tree badges show subtree text units and image placements; their tooltips distinguish each node's own contribution.
The original unpublished [authoring spike](spikes/authoring/README.md) (5218) and
[inspector spike](spikes/inspector/README.md) (5217) remain independent reference experiments.
They are not dependencies of the production implementation.

## Compose and retain

Use `.prompt.tsx` for prompt modules. In a Solid app, configure the
[separate JSX routing](docs/jsx-routing.md) before adding a prompt file.

```tsx
/** @jsxImportSource @habemus-papadum/aiui-prompts */
import {
  Case, Choice, Image, Math, Paragraph, Prompt, Section, Text, Use,
  snapshot, serializeRecord, tex,
} from "@habemus-papadum/aiui-prompts";

const checks = (
  <Section title="Scientific checks">
    <Text value="Preserve units and the exact value 4.500 eV." />
    <Choice name="background" short="State assumptions.">
      <Text value="State assumptions, boundary conditions, and limiting cases." />
    </Choice>
  </Section>
);

const content = (
  <Prompt>
    <Case
      name="session-phase"
      branches={[
        { when: { op: "eq", path: "session.reason", value: "start" },
          value: <Text value="Introduce the experiment." /> },
        { when: { op: "eq", path: "session.reason", value: "reconnect" },
          value: <Text value="Continue without repeating the introduction." /> },
      ]}
      fallback={<Text value="Update the experiment using the latest facts." />}
    />
    <Section title="Hamiltonian">
      <Paragraph>Explain the following model.</Paragraph>
      <Math value={tex`\hat H = \frac{\hat p^2}{2m} + V(\hat x)`} />
      <Use key="theory" value={checks} />
    </Section>
    <Image asset={{ id: "run:42:plot", mimeType: "image/png", revision: "capture-7" }} />
    <Section title="Measurements"><Use key="experiment" value={checks} /></Section>
  </Prompt>
);

// Persist this JSON in the ledger. No derived output cache, functions, or media bytes are retained.
const record = snapshot(content, { context: { session: { reason: "start" } } });
const storedJson = serializeRecord(record);
```

Normal TypeScript handles acquisition, loops, formatting, components, and static control flow.
Use `Case` for decisions based on session facts: a JavaScript `if` before `snapshot` cannot retain
its rejected branch or explain which fact decided it. Components run once during composition;
replay and optimization never call them again.

`Text` takes an exact string. Format numbers explicitly so `4.500` does not become `4.5`.
`tex` is `String.raw`. Prompt and section children are separated by blank lines; `Group` and
`Paragraph` concatenate; `Join` controls separators. A reused section gets its heading depth from
its placement. JSX whitespace follows the TSX compiler; use `Text` for whitespace-sensitive input.

## Recompile, inspect, and select

```ts
import { parseRecord, rehydrate, withRecordOptions } from "@habemus-papadum/aiui-prompts";
import { mappingIndex, measurePrompt, optimizePrompt } from "@habemus-papadum/aiui-prompts/analysis";

const saved = parseRecord(storedJson);
const compiled = rehydrate(saved); // exact recorded compiler, or an explicit diagnostic
const costs = measurePrompt(compiled); // exact text units, images; tokens unknown without an estimator
const mappings = mappingIndex(compiled);

const shorter = withRecordOptions(saved, { selection: { background: "short" } });
const result = optimizePrompt(saved, { budget: 2000, maxCandidates: 32 });
// result.status: fit, infeasible, search-exhausted, or unknown-cost
// Save result.result.record when accepting a candidate. The original stays immutable.
```

Emitted parts preserve text–image–text ordering. Character ranges are half-open UTF-16 offsets
within a text part. Primary contribution ranges partition output exactly, including generated
headings, escaped XML, and elision markers. A source owner is separate from an output offset;
optional source capture does not claim exact source-character or rendered-math-glyph mappings.

## Choose an operation, then a delivery target

A prompt is content. A session update, channel push, and delegated request are different operations.
Their versioned records retain references to deduplicated semantic records, never cached output.

```ts
import {
  channelPush, lowerOperation, responseOperation, sessionOperation,
} from "@habemus-papadum/aiui-prompts/operations";

const push = channelPush(saved, { kind: "prompt" });
const channel = lowerOperation(push, { kind: "claude-channel/1" }, {
  "run:42:plot": { kind: "path", value: "/captures/run-42.png" },
});

const delegation = responseOperation({
  input: saved,
  history: { kind: "remote", provider: "openai",
    reference: { kind: "conversation", id: "conv_example" } },
});
const response = lowerOperation(delegation, { kind: "openai-responses/1", model: "host-selected-model" }, {
  "run:42:plot": { kind: "file", value: "file_host_uploaded" },
});

const event = sessionOperation(saved, {
  action: "input", sessionId: "session_example", eventId: "event_example",
});
const realtime = lowerOperation(event, { kind: "openai-realtime/1" }, {
  "run:42:plot": { kind: "url", value: hostResolvedPngDataUri },
});
```

Instruction replacement and per-response instructions require text-only content. Realtime images
require host-resolved PNG/JPEG data URIs; Responses also accepts hosted URLs and uploaded file IDs. The separate
`live-session/1` profile supports the repository's append protocol; public Realtime does not
pretend to have that extension. Channel media becomes an explicit textual reference with a
recorded decision and mapping. Provider items and remote history references remain separately
owned, unchanged context. Unknown remote history is not an empty conversation.

`lowerOperation` produces a **prepared** delivery, not a sent receipt. The host owns uploads,
credentials, actual sending, and calling `captureWire` at its transport boundary with the payload
that really left. `verifyWire` compares that captured payload with a new derivation.

The built-in profiles are utilities. A consumer can own a versioned `ConsumerAdapter` for a socket,
session, SDK, or another protocol. It declares supported actions, content, and asset representations,
then returns plain JSON, delivery maps, and decisions from immutable compiled bindings. Its payload
may be an event batch or a control action; it need not resemble a model request.

```ts
import { consumerOperation, lowerOperation } from "@habemus-papadum/aiui-prompts/operations";
import { socketAdapter } from "./consumer-adapter"; // implementation lives with the consumer

const append = consumerOperation({
  adapter: socketAdapter.identity,
  action: "append",
  bindings: [{ key: "instructions", content: saved }],
  params: { sessionId: "session_example" },
});
const prepared = lowerOperation(append, {
  kind: "custom", adapter: socketAdapter.identity, options: { channel: "science" },
}, hostAssetBindings, [socketAdapter]);
```

Replay requires that exact adapter name and version. The host retains implementations with their
capability profiles; there is no mutable global registry or fallback to the latest version. See the
[adapter contract](docs/record-contract.md#consumer-owned-adapters) and executable
[socket adapter tests](src/adapters.test.ts).

## Package boundaries

| Import | Responsibility |
| --- | --- |
| Root and `jsx-runtime` | Portable owned authoring, semantic records, compiler, tool snapshots |
| `analysis` | Output queries, accounting, conservative comparison, bounded variant search |
| `operations` | Versioned operation records, consumer adapter framework, and utility lowerers |
| `@habemus-papadum/aiui-prompts-inspector` | Native Solid components, positional Markdown, KaTeX, historical loading |
| `@habemus-papadum/aiui-prompts-vite` | `.prompt.tsx` routing and optional revision-qualified source owners |

These are three independent public packages. Core has no third-party runtime dependencies and runs
in Node or a browser without DOM globals. Its root does not re-export operations; import that explicit
subpath when preparing delivery. Markdown, KaTeX, and Solid belong to the inspector package. Vite and
source instrumentation belong to the build plugin, normally installed as a development dependency.
They use the workspace's public lockstep publication configuration (`dist/` swapped in by
`publishConfig` at pack time); both nested spikes stay private and unpublished.
