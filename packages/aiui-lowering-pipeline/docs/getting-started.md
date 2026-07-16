# Getting Started with @habemus-papadum/aiui-lowering-pipeline

> This page lives at `packages/aiui-lowering-pipeline/docs/getting-started.md`. It's picked up automatically by the
> docs site as a guide under this package — edit or delete it, and add more `*.md` files here for
> additional per-package guides. The package overview comes from the `README.md`; the API
> reference is generated from `src/index.ts`.

The intent lowering pipeline: the framework-free core that folds a multimodal intent event stream into the lowered agent prompt (composeIntent), shared by the channel and the intent tools.

## Install

```sh
npm install @habemus-papadum/aiui-lowering-pipeline
```

## Usage

```ts
import { greet } from "@habemus-papadum/aiui-lowering-pipeline";

greet("world"); // "Hello, world!"
```
