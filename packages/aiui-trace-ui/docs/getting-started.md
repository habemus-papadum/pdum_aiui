# Getting Started with @habemus-papadum/aiui-trace-ui

> This page lives at `packages/aiui-trace-ui/docs/getting-started.md`. It's picked up automatically by the
> docs site as a guide under this package — edit or delete it, and add more `*.md` files here for
> additional per-package guides. The package overview comes from the `README.md`; the API
> reference is generated from `src/index.ts`.

The framework-free lowering-trace debugger UI: `TraceView`/`TracesPane` and the standalone
`/__aiui/debug` page. See the README for the piece map; the everyday entry point is simply:

```sh
aiui dashboard
```

which picks a running channel and serves the viewer against it.

## Install

```sh
npm install @habemus-papadum/aiui-trace-ui
```

## Usage

Embed the pane in any DOM (the intent client's panel does this as a Solid island):

```ts
import { TracesPane } from "@habemus-papadum/aiui-trace-ui";

const pane = new TracesPane({ baseUrl: "http://127.0.0.1:52424" });
host.append(pane.root);
pane.activate(); // starts the list/follow polls; deactivate() stops them
```

Or serve the full standalone page from a Vite dev server:

```ts
import { traceViewer } from "@habemus-papadum/aiui-trace-ui/vite";

export default defineConfig({ plugins: [traceViewer({ port: channelPort })] });
```
