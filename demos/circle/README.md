# demo: circle

How round can you draw a circle? A vanishing-ink pencil surface, a live
least-squares fit, and a Zen centre-ghost — the pencil-package demo.

An in-repo demo wired to the workspace (`workspace:^`, source-first, no build
step), with the demo-package dual shape: run it standalone, or let
`demos/gallery` discover and mount it (the `aiui.sitePage` marker) as one tab
of the published notebook site.

```sh
pnpm dev      # this app (Vite), from this directory
```

Open the printed URL. The voice dock in the corner drives the page's own tools;
it takes an OpenAI key from `OPENAI_API_KEY` in the environment (the dev server
hands it to the page) or from its own key pane. See the
[user guide](../../packages/aiui-viz/docs/frontend-user-guide.md).

The ink document owns strokes. A disposable `PencilSurface` renders it and accepts
input; `inkSignals(document)` supplies live measurements. Completed ink fades
before its working records expire, while the measured score remains in the turn
state. Component replacement adopts the current view; dependency edits recreate
views over the retained document, and unmounting releases input ownership.
