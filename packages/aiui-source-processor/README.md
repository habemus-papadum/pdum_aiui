# @habemus-papadum/aiui-source-processor

The aiui source processor: the compile-time Babel pass that injects factory identity (name/loc/description for cell/control/action) and JSX source-location stamps, plus its Vite plugin. One transform, serve and build.

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
| `locator` | the compiler pass: `false` disables it; an object sets `factories`, `stampJsx` (JSX `data-source-loc` stamps, on in every mode; `false` opts a build out), `stampRoots` (directories beside the root that are app code, like a gallery's sibling demos; their locs read `../demo/src/…`), `locPrefix` |
| `sourceRoot` | what `window.__AIUI__.sourceRoot` says; the Vite root by default (dev-only — a machine path never ships). An explicit value, such as a GitHub URL, seeds every mode |
| `devKeys` | dev-serve only: inject these vendors' keys as `window.__AIUI__.devKeys` for an embedded oracle. A key is read from the dev server's environment at start, and nowhere else — `OPENAI_API_KEY`, `ELEVEN_LABS_API_KEY`, `GEMINI_API_KEY`, `MOTHERDUCK_BROWSER_TOKEN` (a `.env` in the checkout works with direnv); a missing one warns at the first page load |
| `duckdbAssets` | self-host the installed duckdb-wasm binaries and tell the page where |
| `sources: "ship"` | a production build carries its own source under `__aiui/src/` with a manifest, so aiui-viz's `source` and `sources` page tools (and the dock's source browser) read code on the published site as they do on a dev server, which lists its workspace with no option. This publishes the code; pair it with a `sourceRoot` URL so prod stamps link somewhere |
