# Getting Started with @habemus-papadum/aiui-live

> This page lives at `packages/aiui-live/docs/getting-started.md`. It's picked up automatically by the
> docs site as a guide under this package — edit or delete it, and add more `*.md` files here for
> additional per-package guides. The package overview comes from the `README.md`; the API
> reference is generated from `src/index.ts`.

The live oracle — a full-duplex voice front (OpenAI GPT-Live over WebRTC/WebSocket) with pluggable delegation backends: local tools, hosted Responses, or Claude Code.

## Install

```sh
npm install @habemus-papadum/aiui-live
```

## Usage

```ts
import { greet } from "@habemus-papadum/aiui-live";

greet("world"); // "Hello, world!"
```
