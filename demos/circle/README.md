# demo: circle

How round can you draw a circle? A vanishing-ink pencil surface, a live
least-squares fit, and a Zen centre-ghost — the pencil-package demo.

An in-repo demo wired to the workspace (`workspace:^`, source-first, no build
step), with the demo-package dual shape: run it standalone, or let
`demos/gallery` discover and mount it (the `aiui.sitePage` marker) as one tab
of the published notebook site.

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
```

Then open it in the session browser: `./aiui open http://localhost:5173` (from
the repo root), activate the intent client (**⌘B**), and describe what you
want. See [docs/guide/getting-started.md](../../docs/guide/getting-started.md).
