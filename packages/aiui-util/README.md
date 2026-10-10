# @habemus-papadum/aiui-util

The **sidecar contract** and the **client-surface serving helper** that the aiui sidecar
packages (`@habemus-papadum/aiui-pencil`, `@habemus-papadum/aiui-remote-bar`) are built on.

A *sidecar* is an extra HTTP (and optional websocket) surface that a session host mounts on
its own Express app, so one process serves one port. This package is the whole agreement
between the two sides: a sidecar package implements the contract, and the host that mounts
sidecars — which lives outside this repo — consumes it. Neither needs the other to typecheck.

## Install

```sh
npm install @habemus-papadum/aiui-util
```

## The contract — `@habemus-papadum/aiui-util`

Three types, nothing at runtime:

- **`Sidecar`** — a `name` plus `mount(app, ctx)`, which registers routes on the host's Express
  app (once, at startup; may be async) and returns the live handle.
- **`SidecarContext`** — what the host hands over: `mode` (`"dev"` | `"prod"`), `log` (a stderr
  sink — never write to stdout, the host's stdout may carry a protocol), and a lazy `port()`
  (`undefined` until the host is listening).
- **`MountedSidecar`** — the handle: an optional `handleUpgrade(req, socket, head)` to claim a
  websocket upgrade the host didn't, and an optional `dispose()`.

```ts
import type { Sidecar } from "@habemus-papadum/aiui-util";

export const mySidecar: Sidecar = {
  name: "my-tool",
  mount(app, ctx) {
    app.get("/my-tool/info", (_req, res) => res.json({ port: ctx.port() }));
    return { dispose() {} };
  },
};
```

A sidecar confines itself to its own base path; the host's own routes are mounted first and win.

## Serving a web client — `@habemus-papadum/aiui-util/web-surface`

`serveClientSurface(app, options)` is how a sidecar with a page serves it, by `ctx.mode`:

- **dev** — a Vite dev server in middleware mode (HMR, source-first), rooted at `viteRoot`
  (with `viteConfigFile` / `devEntry` / `appType` to override Vite's conventions). HMR rides the
  host's one port: the returned `handleUpgrade` claims the HMR websocket under `prefix`.
- **prod** — static files from the prebuilt bundle at `distDir`. No Vite at runtime; Vite is
  imported lazily and only in dev, so an installed package needs neither Vite nor the dev
  toolchain.

Register the sidecar's own routes on the app *before* calling it so they take precedence, and
compose the returned `handleUpgrade` / `dispose` into the sidecar's `MountedSidecar` handle.
It is a separate entry so the main entry never pulls the lazy-Vite module.
