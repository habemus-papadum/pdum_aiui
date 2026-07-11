# @habemus-papadum/aiui-extension

The aiui intent tool as a Chrome MV3 extension: per-window side panel (the tool's whole visible
surface), channel binding, capture, ink, page tools. Design:
`docs/proposals/browser-extension-intent-tool.md`; measured groundwork:
`archive/extension-spikes/RESULTS.md`. Built on
[`@habemus-papadum/aiui-webext`](../aiui-webext/README.md).

> **Picking this work up fresh?** Read [`docs/CONTINUITY.md`](./docs/CONTINUITY.md) first — status,
> working agreements, the traps that already cost cycles, and the ordered plan for what's next.

## Development

```sh
pnpm -C packages/aiui-extension dev     # Vite dev server, pinned port 5317 (strict)
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → this package's `dist/`.
The persistent session-browser profile keeps it installed; pin the toolbar action (puzzle-piece
menu) — clicking it opens the window's side panel and, later, invokes the tab for capture.

Two things the spikes taught, now load-bearing:

- **`dist/` has two shapes.** `pnpm dev` writes HMR loader stubs that require the dev server;
  `pnpm build` writes the standalone production extension. After switching modes, **Reload** the
  extension in `chrome://extensions` — same path, different artifact. **Corollary (learned the
  hard way, twice):** running `pnpm build` as a CI-style gate while a dev install is live
  silently freezes the installed extension at that moment's code — the dev server does NOT
  rewrite `dist/` on edits, only on startup. After any `pnpm build`, restart `pnpm dev` before
  touching the browser again.
- **A squatted dev port fails loudly (by design).** If vite refuses to start, find the squatter
  (`lsof -iTCP:5317 -sTCP:LISTEN`); never retry as `vite <port>` — a bare positional arg is a
  root directory, not a port.

HMR expectations: content-script edits update in place (module state stashed on `window`
survives — see `src/content.ts`); panel edits are plain Vite HMR; service-worker/manifest edits
reload the whole extension.
