# Getting Started with @habemus-papadum/aiui-intent-client

> This page lives at `packages/aiui-intent-client/docs/getting-started.md`. It's picked up automatically by the
> docs site as a guide under this package — edit or delete it, and add more `*.md` files here for
> additional per-package guides. The package overview comes from the `README.md`; the API
> reference is generated from `src/index.ts`.

The greenfield intent client: a detached plain-page panel on the mode engine — agent-drivable, HMR-native; the MV3 extension is a shell added last.

## Install

```sh
npm install @habemus-papadum/aiui-intent-client
```

## Usage

```ts
import { greet } from "@habemus-papadum/aiui-intent-client";

greet("world"); // "Hello, world!"
```
