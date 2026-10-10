# Route prompt JSX separately from UI JSX

Add `@habemus-papadum/aiui-prompts-vite` as a development dependency and configure it beside the
host's Solid plugin:

```ts
import { promptFilePattern, prompts } from "@habemus-papadum/aiui-prompts-vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [prompts({ sourceLocations: true }), solid({ exclude: promptFilePattern })],
});
```

Use `.prompt.tsx` for prompt modules, with the per-file pragma
`/** @jsxImportSource @habemus-papadum/aiui-prompts */`. Keep ordinary UI components in `.tsx`.
Source capture is optional; the core functions and JSX runtime do not require Vite.

Read the [routing guide](../../aiui-prompts/docs/jsx-routing.md) for source revision/offset semantics,
mixed compiler configuration, and its tests. The [core getting-started guide](../../aiui-prompts/docs/getting-started.md)
shows composition, recorded session decisions, and JSON retention.
