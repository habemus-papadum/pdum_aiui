# @habemus-papadum/aiui-code-protocol

The **wire contract** shared by the aiui [code reader](../aiui-code)'s frontend
(`@habemus-papadum/aiui-code`, the browser) and backend
(`@habemus-papadum/aiui-code-server`, the Node side). Transport-agnostic plumbing with **zero
runtime dependencies**: the HTTP route strings, the request/response payload shapes they carry, the
`/lsp` websocket byte-relay convention, and the walkthrough model.

## Why a third package

Both halves import the same routes, the same URL builders, and the same payload types, so the two
can never drift on the bytes they exchange — the frontend fetches exactly the routes the backend
serves. Keeping the contract dependency-free (not in the server, which the browser would then have
to depend on) is what lets the browser bundle stay clear of Node code and lets the frontend and
backend be built, published, and versioned independently. The dependency graph is acyclic:
**frontend → protocol** and **server → protocol**, nothing pointing back.

## What's in it

Routes and helpers:

- `AIUI_CODE_PREFIX` — `"/__aiui_code"`. Every reader endpoint lives under this prefix so a host
  (a Vite dev server, or the channel) can mount them without colliding with its own routes.
- `ROUTES` — the route table: `info`, `tree`, `read`, `walkthroughs`, `lspServers`, and the `lsp`
  websocket.
- `walkthroughPath(id)` — a single walkthrough's URL.
- `lspSocketUrl(origin, languageId)` — build the `/lsp` websocket URL for a language against a
  backend origin (flips `http(s)` → `ws(s)`, adds `?lang=`).

Payload types: `FileEntry`, `FileTreeResponse`, `FileReadResponse`, `BackendInfo`,
`LspServerInfo`, `LspServersResponse`, `WalkthroughListResponse`.

Walkthrough model (Tier 3 guided tours): `Walkthrough`, `WalkthroughStep`, `WalkthroughSummary`.

## The `/lsp` convention

The one rule the two halves must agree on beyond the payload shapes: the `/lsp` socket is a **byte
relay**, not a semantic endpoint. The browser runs a real LSP client; the backend reframes
`Content-Length`-framed JSON-RPC ↔ one JSON message per websocket **text** frame and spawns the
real language server. Nothing in the middle rewrites LSP semantics — the "no veneer" constraint
(see [Language Servers](../../docs/guide/lsp.md)).

## See also

- [The Code Reader](../../docs/guide/code-reader.md) — the three-package split and how it's hosted.
- [`@habemus-papadum/aiui-code`](../aiui-code) — the frontend · [`…-server`](../aiui-code-server) — the backend.
