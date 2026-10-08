# @habemus-papadum/aiui-source-processor

The aiui source processor: the compile-time Babel pass that injects factory identity (name/loc/description for cell/control/action) and dev-only JSX source-location stamps, plus its Vite plugin. One transform, serve and build.

## Install

```sh
npm install @habemus-papadum/aiui-source-processor
```

## Usage

```ts
import aiui from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({ plugins: [aiui(), solid()] }); // aiui() BEFORE solid()
```

`aiui(options)` returns the plugin set. Everything is optional:

| option | what it does |
| --- | --- |
| `locator` | the compiler pass: `false` disables it; an object sets `factories`, `stampJsx` (JSX `data-source-loc` stamps — dev-only unless `true`), `stampRoots` (directories beside the root that are app code, like a gallery's sibling demos; their locs read `../demo/src/…`), `locPrefix` |
| `sourceRoot` | what `window.__AIUI__.sourceRoot` says; the Vite root by default (dev-only — a machine path never ships). An explicit value, such as a GitHub URL, seeds every mode |
| `devKeys` | dev-serve only: inject these vendors' keys as `window.__AIUI__.devKeys` for an embedded oracle |
| `duckdbAssets` | self-host the installed duckdb-wasm binaries and tell the page where |
| `sources: "ship"` | a production build carries its own source under `__aiui/src/` with a manifest, so aiui-viz's `source` page tool reads code on the published site. This publishes the code; pair it with `stampJsx: true` and a `sourceRoot` URL |
