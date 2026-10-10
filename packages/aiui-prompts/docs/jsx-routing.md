# Prompt JSX in a Solid application

Prompt modules use the **`.prompt.tsx`** extension. Ordinary `.tsx` files remain
Solid components. These are separate JSX languages; a prompt component produces
semantic data and never mounts DOM.

```ts
// vite.config.ts
import aiui from "@habemus-papadum/aiui-source-processor";
import { promptFilePattern, prompts } from "@habemus-papadum/aiui-prompts-vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [aiui(), prompts(), solid({ exclude: promptFilePattern })],
});
```

The installed Solid plugin accepts `exclude`. Its filter sees the entire Vite
module ID, so the exported regular expression includes query suffixes. If the app
already has exclusions, use `exclude: [existingExclusion, promptFilePattern]`.
The aiui source locator explicitly skips `.prompt.tsx`, including its standalone
Babel pass. No dependency on the aiui locator is needed by the prompt compiler.

Each prompt file also declares its JSX runtime for TypeScript and editor tooling:

```tsx
/** @jsxImportSource @habemus-papadum/aiui-prompts */
import { Prompt, Text } from "@habemus-papadum/aiui-prompts";

export const greeting = (name: string) => (
  <Prompt>
    <Text value={`Hello ${name}`} />
  </Prompt>
);
```

The app can keep `jsx: "preserve"` in its `tsconfig.json` for Solid; the per-file
import-source pragma selects the prompt JSX types, while Vite's prompt plugin
selects the automatic runtime for emission.
The owning compiler for `.prompt.tsx` is this package; do not put a different
`@jsxImportSource` or a classic-runtime pragma in a prompt module.

`prompts()` uses Vite 8's TSX transform only for prompt modules. It works in both
serve and build, emits a standard JavaScript source map, and preserves normal
TypeScript control flow. Asset imports such as `?raw` and `?url` remain assets.
This routing pass does not evaluate session decisions, inject DOM source stamps,
or claim exact authored-text provenance. Its standard source map is distinct from
the toolkit's semantic record and output-contribution maps.

The tests under `packages/aiui-prompts-vite/test/routing/` exercises the actual installed aiui, Solid, and
prompt plugins together: dev transforms, execution of the prompt via Vite's
module runner, and a production consumer build. The ordinary UI receives DOM
source stamps and the Solid transform; the prompt uses the toolkit runtime and
contains semantic data. The fixture imports public package exports rather than
reaching into the implementation.

## Optional source owners

Enable `prompts({ sourceLocations: true })` to capture source locations. Paths are
relative to the Vite root; `sourceRoot` can choose another root for source
resolution across packages. A captured origin has this shape:

```json
{
  "kind": "source",
  "file": "src/greeting.prompt.tsx",
  "revision": "sha256:…",
  "span": { "start": 124, "end": 158 },
  "site": "construction",
  "precision": "owner"
}
```

The revision is SHA-256 of the complete original file encoded as UTF-8. Bounds
are zero-based, half-open UTF-16 offsets in that file. `construction` covers a
complete JSX element or shorthand fragment. `interpolation` covers a child
expression's syntax, excluding its surrounding braces, including explicit
`children={fragment}` attributes. A source resolver must match the revision
before treating a range as current source.

Construction and placement remain separate: a shared fragment keeps its
construction owner, and each `{fragment}` interpolation introduces a distinct
placement owner. Imported aliases, namespace components, and ordinary wrapper
components need no special registration. The transform does not infer the source
of arbitrary JavaScript return values, fragments arriving through object spreads,
or the call site of `snapshot`/`compilePrompt`; those relationships are
unavailable unless the caller supplies explicit lineage.

The transform injects the reserved `__promptOrigin` prop, which the runtime
removes before calling a component, and wraps interpolation evaluation with the
runtime's `withPromptOrigin` helper. The helper preserves nested arrays and item
boundaries, and source owners accumulate as placement lineage without adding
semantic groups. Explicit author use of that reserved prop is rejected when
instrumentation is on. Components should treat their children as `PromptValue`
and compose them rather than depend on their internal node shape. Tests assert
identical compiled output, occurrence paths, decisions, and author-side effect
order with capture off and on. They cover array joins and item elision as well as
getters, spreads, keys, wrapper props, shorthand fragments, and repeated uses.
The automatic runtime's `createElement` fallback also handles the
TypeScript/JSX case where a key follows a spread.

The JavaScript source map composes the insertion map with the TSX transform, so
debugger positions still refer to the original file. An owner span is **not** an
exact source-character-to-output-character correspondence: escaping, Markdown,
JSX whitespace, and expression evaluation still require the toolkit's distinct
semantic contribution maps. Source capture does not record session-state
conditionals; use the semantic `Case`/decision API for those.
