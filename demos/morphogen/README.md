# demo: morphogen

Gray-Scott reaction–diffusion lab: a WebGL simulation island, a worker analysis
pipeline, and an observable history ring — the original aiui reference
notebook.

An in-repo demo wired to the workspace (`workspace:^`, source-first, no build
step), with the demo-package dual shape: run it standalone, or let
`demos/gallery` discover and mount it (the `aiui.sitePage` marker in
package.json) as one tab of the published notebook site.

```sh
pnpm dev      # this app (Vite), from this directory
```

Open the printed URL. The voice dock in the corner drives the page's own tools;
it takes an OpenAI key from `OPENAI_API_KEY` in the environment (the dev server
hands it to the page) or from its own key pane. See the
[user guide](../../packages/aiui-viz/docs/frontend-user-guide.md).
