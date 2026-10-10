# Prompt JSX and source capture for Vite

A build-time companion to `@habemus-papadum/aiui-prompts`. Install it as a development dependency;
the portable core has no dependency on Vite, its parsers, or source instrumentation.

```ts
import { promptFilePattern, prompts } from "@habemus-papadum/aiui-prompts-vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [prompts({ sourceLocations: true }), solid({ exclude: promptFilePattern })],
});
```

Prompt files use `.prompt.tsx` and start with
`/** @jsxImportSource @habemus-papadum/aiui-prompts */`. Other `.tsx` files remain Solid components.
The plugin routes only prompt modules through the owned JSX runtime. It optionally captures
revision-qualified source owner spans, while preserving author-side evaluation order and compiled
prompt meaning. Vite's normal JavaScript source maps are separate from semantic contribution maps.
The aiui source locator already excludes prompt modules in both passes, but is not required here.

See [routing and source provenance](../aiui-prompts/docs/jsx-routing.md) for configuration and
precision guarantees. `test/routing` exercises the real Solid, aiui, and prompt plugins together
in dev transforms, module execution, and a production build. No prompt is evaluated at build time.
