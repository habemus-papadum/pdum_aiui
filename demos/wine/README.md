# demo: wine

In-repo aiui demo: wine.

An in-repo demo wired to the workspace (`workspace:^`, no npm install of aiui packages, no build
step). Run it from this directory:

```sh
pnpm dev      # this app (Vite)
```

Open the printed URL. The voice dock in the corner drives the page's own tools; it takes an OpenAI
key from `OPENAI_API_KEY` in the environment (the dev server hands it to the page) or from its own
key pane. See the [user guide](../../packages/aiui-viz/docs/frontend-user-guide.md).
