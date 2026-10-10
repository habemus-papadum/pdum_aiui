# Getting Started with @habemus-papadum/aiui-oracle

> This page lives at `packages/aiui-oracle/docs/getting-started.md`, beside the package's other
> guides. The package overview is the `README.md`; the API is `src/index.ts`.

The oracle is a realtime voice control surface for an aiui app: a browser-side WebRTC session
to OpenAI's Realtime API with the app's controls and actions projected as tools.

## Install

```sh
npm install @habemus-papadum/aiui-oracle
```

## Where to start

[The Oracle](./oracle.md) is the full guide: the two-step developer setup in an aiui app (opt
the Vite plugin into `devKeys`, mount the component), how keys resolve (pasted key, dev key,
or a mint endpoint from `./server`), the session engine and its ledger, the woven prompt
slots, and the tool projection.

The quickest way to see it running is the voice dock: `@habemus-papadum/aiui-dock` mounts the
oracle beside any aiui page, and every scaffolded app (`create-aiui`) and the notebook gallery
carry it.
