# Getting Started with @habemus-papadum/aiui-intent-runtime

> This page lives at `packages/aiui-intent-runtime/docs/getting-started.md`. It's picked up automatically by the
> docs site as a guide under this package — edit or delete it, and add more `*.md` files here for
> additional per-package guides. The package overview comes from the `README.md`; the API
> reference is generated from `src/index.ts`.

The intent client's host-agnostic capture + transport runtime: mic/screen capture, the frame
sampler, the selection watcher, and the channel wire. See the README for the entry map and the
core-vs-edge discipline; the living consumer is `@habemus-papadum/aiui-intent-client`.

## Install

```sh
npm install @habemus-papadum/aiui-intent-runtime
```

## Usage

Each job is a lean subpath entry; a host composes the ones it needs and injects its own browser
edges. The smallest useful example — locate the components a screenshot rectangle framed:

```ts
import { locateComponents } from "@habemus-papadum/aiui-intent-runtime/shot";

const components = locateComponents({ x: 40, y: 120, w: 480, h: 260 });
// → [{ component: "Controls", source: "src/ui/Controls.tsx:44:7", … }]
```

For the full composition — wire + talk lanes + sampler bound to a mode engine — read
`aiui-intent-client`'s `src/lanes.ts`, which is the reference host.
