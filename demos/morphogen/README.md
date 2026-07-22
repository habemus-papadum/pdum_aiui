# demo: morphogen

Gray-Scott reaction–diffusion lab: a WebGL simulation island, a worker analysis
pipeline, and an observable history ring — the original aiui reference
notebook.

An in-repo demo wired to the workspace (`workspace:^`, source-first, no build
step), with the demo-package dual shape: run it standalone, or let
`demos/gallery` discover and mount it (the `aiui.sitePage` marker in
package.json) as one tab of the published notebook site.

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
```

Then open it in the session browser — the window you share with the agent:

```sh
./aiui open http://localhost:5173   # from the repo root
```

Activate the intent client (**⌘B**) and describe what you want. See
[docs/guide/getting-started.md](../../docs/guide/getting-started.md).
