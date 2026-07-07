# Getting Started with @habemus-papadum/aiui-lsp

> This page lives at `packages/aiui-lsp/docs/getting-started.md`. It's picked up automatically by the
> docs site as a guide under this package — edit or delete it, and add more `*.md` files here for
> additional per-package guides. The package overview comes from the `README.md`; the API
> reference is generated from `src/index.ts`.

Project-local LSP subsystem for aiui: a tested executable-launcher descriptor format, a stdio byte-relay proxy, and a self-test probe harness — shared by the code reader and the channel.

## Install

```sh
npm install @habemus-papadum/aiui-lsp
```

## Usage

```ts
import { greet } from "@habemus-papadum/aiui-lsp";

greet("world"); // "Hello, world!"
```
