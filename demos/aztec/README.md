# demo: aztec

Random domino tilings of the Aztec diamond: a streaming shuffle worker, a
scrubbable growth ring, the arctic circle, and Ryser-permanent checks.

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
