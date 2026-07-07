# @habemus-papadum/aiui-code-server

The **Node backend** for the aiui [code reader](../aiui-code) — the cwd-bound services the
browser reader talks to: the `/__aiui_code` HTTP routes (file tree/read, walkthroughs, the
project's configured LSP servers) and the `/lsp` websocket **byte-relay** that spawns the real
language servers. It speaks the wire contract from
[`@habemus-papadum/aiui-code-protocol`](../aiui-code-protocol); the reader frontend
(`@habemus-papadum/aiui-code`) is the client. Node-only.

The reader was designed to run its backend **inside the running session**, so this package ships
one core plus two host adapters — the same handler code, mounted on whichever http/ws server fits.

## The core: a host-neutral backend

`mountAiuiCodeBackend({ root, cacheDir?, onLog? })` returns a `MountedBackend` with two seams:

- `handleHttp(req, res)` — serve an `/__aiui_code/*` request; returns `true` if it claimed it.
- `handleUpgrade(req, socket, head)` — claim the `/lsp` websocket upgrade; returns `true` if it
  took the socket, and **never destroys a non-matching upgrade**, so it coexists with a host's
  own websockets (Vite HMR, the channel's `/ws`).
- `dispose()` — kill spawned language servers and release resources.

It handles only its own routes and hands everything else back untouched. The `/lsp` relay is the
"no veneer" byte pipe from [`@habemus-papadum/aiui-lsp`](../aiui-lsp): `Content-Length`-framed
JSON-RPC over stdio ↔ one JSON message per websocket text frame, to a real language server spawned
in `root`. Nothing in the middle understands or rewrites LSP semantics.

## Two host adapters

- **`@habemus-papadum/aiui-code-server/sidecar`** — `codeReaderSidecar({ root })` packages the
  backend as a channel [`Sidecar`](../aiui-claude-channel). This is the **primary path**: `aiui
  claude` hands it to the channel so one session process serves the reader (see the
  [Code Reader guide](../../docs/guide/code-reader.md)). Language servers spin up lazily per
  connection and are disposed on channel close. Backend calls are cross-origin (the reader page is
  served by the app's dev overlay, on a different origin), so the backend sends permissive CORS.

  ```ts
  import { codeReaderSidecar } from "@habemus-papadum/aiui-code-server/sidecar";
  const sidecar = codeReaderSidecar({ root: "/abs/project" });
  // mounted by the channel under /__aiui_code/* + the /lsp upgrade
  ```

- **`@habemus-papadum/aiui-code-server/vite`** — `aiuiCodeBackendPlugin({ root })` mounts the same
  backend on a **Vite dev server** (the `/__aiui_code/*` routes as connect middleware, the `/lsp`
  relay via the http server's `upgrade` event). This is the standalone reader-dev harness — for
  hacking on `@habemus-papadum/aiui-code` itself, where the reader page and backend are same-origin.

  ```ts
  // packages/aiui-code/vite.config.ts
  import { aiuiCodeBackendPlugin } from "@habemus-papadum/aiui-code-server/vite";
  export default defineConfig({ plugins: [aiuiCodeBackendPlugin({ root: process.cwd() })] });
  ```

## Exports

- `.` — `mountAiuiCodeBackend`, `MountedBackend`, `AiuiCodeBackendDeps`; `createWalkthroughStore`,
  `WalkthroughStore`, `WalkthroughStoreOptions`.
- `./sidecar` — `codeReaderSidecar`, `CodeReaderSidecarOptions`.
- `./vite` — `aiuiCodeBackendPlugin`, `AiuiCodeBackendOptions`.

`express` and `vite` are optional peers — pull in `./` or `./vite` and you only need the one your
host uses; the channel provides Express for the sidecar path.

## See also

- [The Code Reader](../../docs/guide/code-reader.md) — how the reader is wired into a session.
- [Language Servers](../../docs/guide/lsp.md) — the LSP setup the `/lsp` relay drives.
- [`@habemus-papadum/aiui-code`](../aiui-code) — the frontend · [`…-protocol`](../aiui-code-protocol) — the wire contract.
