# Getting Started with @habemus-papadum/aiui-webext

> This page lives at `packages/aiui-webext/docs/getting-started.md`. It's picked up automatically by the
> docs site as a guide under this package — edit or delete it, and add more `*.md` files here for
> additional per-package guides. The package overview comes from the `README.md`; the API
> reference is generated from `src/index.ts`.

Shared infrastructure for building aiui Chrome extensions: CRXJS/Vite config factory, manifest helpers, port relay, side-panel pane primitives.

## Install

```sh
npm install @habemus-papadum/aiui-webext
```

## Usage

```ts
import { greet } from "@habemus-papadum/aiui-webext";

greet("world"); // "Hello, world!"
```
