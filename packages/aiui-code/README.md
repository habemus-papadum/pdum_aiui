# @habemus-papadum/aiui-code

An **LSP-backed, Monaco-based read-only code reader** for the aiui cockpit — the
"code half" of the loop the dev overlay opened (code ↔ UI ↔ running client).
Navigate a project by definition / references / symbol, jump and jump back,
fold, hover for types, read a project-wide symbol search — a power tool for a
senior developer who wants to *read and move fast*, not an IDE.

This package is the **frontend** — a browser-only SolidJS app, session-agnostic:
`mountCodeReader(el)` renders the reader into an element and returns
`{ reader, dispose }`. Its **backend** (the LSP byte-relay and the file /
walkthrough routes) lives in
[`@habemus-papadum/aiui-code-server`](../aiui-code-server); the **wire contract**
they share, in [`@habemus-papadum/aiui-code-protocol`](../aiui-code-protocol). How
the three fit together, and how the backend is hosted *inside the running
session* as a channel sidecar, is the [Code Reader
guide](../../docs/guide/code-reader.md).

Implements [`docs/proposals/code-reader.md`](../../docs/proposals/code-reader.md):
**Tier 1** (the LSP reader) is complete; **Tier 3** (AI-authored guided tours)
ships as a working skeleton (the `create_walkthrough` agent tool + a narrated,
diff-aware stepper). Tier 2 (select-code → compose) is wired for at the seams
(`SelectionSnapshot` is emitted as a coarse signal) but not yet plugged into the
intent pipeline.

## Run it

```sh
# one-time: create the demo project's venv so pyright resolves numpy
pnpm --filter @habemus-papadum/aiui-code setup:example

# start the reader (serves + runs pyright against examples/py-demo by default)
pnpm --filter @habemus-papadum/aiui-code dev
```

Point it at a different project with `AIUI_CODE_ROOT=/abs/path pnpm … dev`.

The reader reads `examples/py-demo` — a small numpy project with genuine
cross-module structure (`Vec3` in `geometry.py` used by `mesh.py` and
`pipeline.py`, …) so definition/references have interesting targets.

Power-tool keys: **⌘P** go-to-file · **⌘⇧O** symbol jump · **F12** definition ·
**⇧F12** references · **⌘[ / ⌘]** jump back / forward.

## Architecture (the frontend)

A heavy browser UI app; the thin cwd-bound services it talks to are a separate
package (see below). The `src/` (browser) half is a SolidJS 2.0 app built on
`@habemus-papadum/aiui-viz`, following the frontend-for-agents methodology:

- **Monaco is a durable imperative island** (`model/reader.ts`, held in
  `durable("code-reader/reader", …)`): the editor, its text models, view
  state, the LSP client, and the nav history survive HMR. The SolidJS chrome
  (`ui/`) is disposable and rebuilt freely; it drives the island through a
  small command+observation surface and never makes Monaco's per-keystroke
  state a reactive cell.
- **Cells at the coarse edges only** (`model/graph.ts`): the file tree and the
  current file's outline are `cell()`s over the durable roots; `currentFile`,
  `selection`, `cursor`, `lspStatus`, `diagnostics` are coarse signals out.
- **The agent tool surface** (`agentToolkit("aiuiCode")`): `open_file`,
  `reveal`, `goto_definition`, `find_references`, `workspace_symbol`,
  `outline`, `back`/`forward`, `create_walkthrough`, plus a bounded `report()`.
  Via the dev overlay these become `page_tools_*` MCP tools, so the session can
  drive and verify the reader.
- **A session panel** (`ui/SessionPanel.tsx`): the reader joins the aiui
  **session bus** as a `code` *contributor* — it mirrors the app tab's arming +
  prompt preview and lets you **Add to prompt →** the current code selection
  (short → inlined, long → fenced context). It hosts no turn of its own; the dev
  overlay serves this reader at `/__aiui/code` and wires it as a `code`-role
  contributor for you (`aiuiDevOverlay({ code: true })`). See the repo's
  **Multi-View Sessions** and **Code Reader** guides.

The backend it talks to — the `/lsp` byte-relay plus the `/files` and
`/walkthroughs` routes under `/__aiui_code` — is a separate package,
[`@habemus-papadum/aiui-code-server`](../aiui-code-server), which `mountCodeReader`
reaches over the channel port (or, in the standalone harness, on the dev server's
own origin). See its README and the [Code Reader
guide](../../docs/guide/code-reader.md).

## One deliberate deviation: a direct LSP client, not `monaco-languageclient`

The proposal names `monaco-languageclient` as the turnkey path to *undiluted*
LSP. This package instead ships a **small, direct LSP client**
(`src/lsp/client.ts`, ~250 lines on `vscode-languageserver-protocol` types) that
speaks genuine JSON-RPC over the `/lsp` websocket and maps results into Monaco
providers (`src/lsp/lsp-monaco.ts`). Rationale:

- `monaco-languageclient@10` pulls in the whole `@codingame/monaco-vscode-api`
  service layer. For a focused **read-only** surface, a direct client is far more
  legible and debuggable.
- The constraint that actually matters — **undiluted LSP on the wire** — is
  fully honored: the browser issues real `initialize`, `textDocument/definition`,
  `.../references`, `.../hover`, `.../documentSymbol`, `.../foldingRange`,
  `workspace/symbol`, and consumes real `publishDiagnostics`. Cross-file
  navigation uses Monaco's public `registerEditorOpener`.

If Tier 2/3 grow to need capabilities the direct client doesn't cover, swapping
in `monaco-languageclient` behind the same `ReaderNavHost` seam is a contained
change.

## Notes

- **Language scope:** whatever the project's `.aiui/lsp` manifest configures
  (see [Language Servers](../../docs/guide/lsp.md)) — python (pyright) and
  typescript/javascript are built-in recipes, others are hand-authored. The
  server registry and byte-relay live in
  [`@habemus-papadum/aiui-lsp`](../aiui-lsp).
- **Minimap is off by default:** its continuous canvas rendering starves the
  compositor and hangs Chrome-DevTools-MCP screenshots, and screenshotting the
  live UI through that MCP is the core aiui workflow.
- **Published** (`--public`): a developer cockpit that ships as the reader
  frontend, paired with `aiui-code-server` and `aiui-code-protocol`.
