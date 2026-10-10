# Build, retain, and inspect a prompt

`@habemus-papadum/aiui-prompts` owns authoring, plain JSON semantic records, and deterministic
compilation. It runs in Node.js or a browser without DOM globals or third-party runtime dependencies.
Use the separate [inspector package](../../aiui-prompts-inspector/README.md) in UI hosts and the
[Vite package](../../aiui-prompts-vite/README.md) for optional source capture and `.prompt.tsx` routing.
All three packages are public; the two earlier spikes remain private reference experiments.

## Capture a semantic record

The function API works in an ordinary TypeScript module, with no JSX or build plugin:

```ts
import {
  Case, Image, Math, Prompt, Section, Text,
  serializeRecord, snapshot, tex,
} from "@habemus-papadum/aiui-prompts";

const prompt = Prompt({ children: [
  Case({
    name: "session-phase",
    branches: [{
      when: { op: "eq", path: "session.reason", value: "start" },
      value: "Introduce the experiment.",
    }],
    fallback: "Continue the experiment without repeating the introduction.",
  }),
  Section({ title: "Measurement", children: [
    Text({ value: "Preserve the measured precision: 4.500 eV." }),
    Math({ value: tex`E = mc^2` }),
    Image({ asset: { id: "run:42:plot", mimeType: "image/png", revision: "capture-7" } }),
  ] }),
] });

const record = snapshot(prompt, { context: { session: { reason: "start" } } });
const storedJson = serializeRecord(record); // Store this in the application's ledger or database.
```

`Case` retains the alternatives, observed facts, and selected branch. Use it for choices based on
session state. Author-side TypeScript remains available for loops, helpers, data acquisition, and
static decisions, but an `if` executed before capture cannot explain its rejected branch afterward.

Section heading depth is resolved from global placement. `Math` retains raw TeX. Images remain
atomic parts interleaved with text; their descriptors are recorded, while the host retains the
actual bytes. Text is exact: format numbers explicitly when scientific precision matters.

JSX is a second spelling of the same composition model. Put prompt JSX in `.prompt.tsx`, add
`/** @jsxImportSource @habemus-papadum/aiui-prompts */`, and follow the
[routing configuration](jsx-routing.md) before using it in a Solid application. Prompt JSX produces
immutable prompt values; UI JSX produces Solid components. They use separate JSX runtimes.

## Read back and derive output

```ts
import { parseRecord, rehydrate } from "@habemus-papadum/aiui-prompts";
import { mappingIndex, measurePrompt } from "@habemus-papadum/aiui-prompts/analysis";

const saved = parseRecord(storedJson);
const compiled = rehydrate(saved);
const parts = compiled.parts; // Ordered { type: "text", text } / { type: "image", asset } values.
const contributions = compiled.contributions; // Exact output owners, including generated framing.
const mappings = mappingIndex(compiled);
const costs = measurePrompt(compiled); // Text units and images; tokens under the conservative estimator (labelled estimated, no model count.
```

Replay executes the recorded compiler, never the original author functions. Unknown schemas or
compiler versions produce explicit errors. Output ranges use half-open UTF-16 offsets within a
text part; images have atomic addresses. Retain the semantic record as the durable source of truth.
The emitted parts and maps can always be derived again with the recorded implementation.

Tool declarations use `toolSnapshot(kits, origin)`. Its fingerprint identifies the ordered
declaration content independently of capture origin, so the same document captured in an oracle
and a live session shares an identity. Origin remains recorded separately and is included in the
enclosing semantic or operation record's fingerprint. See the
[identity contract](record-contract.md#composition-and-compilation).

## Prepare a consumer operation

A prompt is content, separate from an operation or a message history. Import delivery helpers
explicitly; the package root does not load them:

```ts
import {
  channelPush, lowerOperation, serializeOperation,
} from "@habemus-papadum/aiui-prompts/operations";

const operation = channelPush(saved, { kind: "scientific-review" });
const storedOperation = serializeOperation(operation);
const prepared = lowerOperation(operation, { kind: "claude-channel/1" }, {
  "run:42:plot": { kind: "path", value: "/captures/run-42.png" },
});
```

This prepares a payload and maps; it sends nothing. Session instruction replacement/appends,
channel text with asset references, Responses delegation, and custom versioned adapters have
different operation contracts. Remote conversation references and retained provider history remain
separate from optimizable current content. The host owns sending and calls `captureWire` with the
payload that actually crossed its transport boundary. See the
[operation contract](record-contract.md#three-consumers-and-separate-history).

## Inspect the saved record

Load the semantic JSON in the [native Solid inspector](../../aiui-prompts-inspector/README.md).
It can also inspect operation bindings and captured delivery alongside the referenced operation.
Use its compact preview for embedded widgets, or its full tree/raw/Markdown/provenance view for
debugging. Asset and source resolution are host services, so a historical viewer does not need to
import the application that originally authored the prompt.

From the repository root, start the real workbench with:

```sh
pnpm --filter @habemus-papadum/aiui-prompts-inspector dev
```

Open <http://127.0.0.1:5219>. The independent authoring and inspector spikes remain available on
ports 5218 and 5217 through the [authoring spike](../spikes/authoring/README.md) and
[inspector spike](../spikes/inspector/README.md) scripts. Their fixed artifacts are reference material;
the workbench uses the actual compiler and viewer.

The [adoption guide](adoption.md) explains the package split and migration changes. The
[styling contract](theming.md) documents optional styles, host themes, and per-instance overrides.
