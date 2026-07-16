# Getting Started with @habemus-papadum/aiui-source-processor

> This page lives at `packages/aiui-source-processor/docs/getting-started.md`. It's picked up automatically by the
> docs site as a guide under this package — edit or delete it, and add more `*.md` files here for
> additional per-package guides. The package overview comes from the `README.md`; the API
> reference is generated from `src/index.ts`.

The aiui source processor: the compile-time Babel pass that injects factory identity (name/loc/description for cell/control/action) and dev-only JSX source-location stamps, plus its Vite plugin. One transform, serve and build.

## Install

```sh
npm install @habemus-papadum/aiui-source-processor
```

## Usage

```ts
import { greet } from "@habemus-papadum/aiui-source-processor";

greet("world"); // "Hello, world!"
```
