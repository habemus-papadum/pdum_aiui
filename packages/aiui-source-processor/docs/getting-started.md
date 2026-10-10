# Getting Started with @habemus-papadum/aiui-source-processor

> This page lives at `packages/aiui-source-processor/docs/getting-started.md`. It's picked up automatically by the
> docs site as a guide under this package — edit or delete it, and add more `*.md` files here for
> additional per-package guides. The package overview comes from the `README.md`; the API
> reference is generated from `src/index.ts`.

The aiui source processor: the compile-time Babel pass that injects factory identity (name/loc/description for cell/control/action) and JSX source-location stamps, plus its Vite plugin. One transform, serve and build.

## Install

```sh
npm install @habemus-papadum/aiui-source-processor
```

## Usage

```ts
// vite.config.ts — before solid(), so the locator's `pre` pass stamps JSX first
import aiui from "@habemus-papadum/aiui-source-processor";
import solid from "vite-plugin-solid";

export default { plugins: [aiui(), solid()] };
```

The plugin stamps JSX with `data-source-loc` (every mode; `stampJsx: false` opts a build out),
injects `cell()`/`control()` identities, and under `vite serve` lists the project's sources for
the page's `sources`/`source` tools. Opt-ins: `devKeys` (vendor keys from the dev server's
environment — `OPENAI_API_KEY` and friends, a `.env` with direnv works — seeded into served pages
only), `sources: "ship"`, `duckdbAssets`.
