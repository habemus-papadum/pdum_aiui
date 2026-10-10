# demo: twins

**One slice, two instances** — the worked example of the aiui composability model
(`scope`, slice factories, cross-package identity):

- Both oscilloscopes are the SAME reusable slice —
  [`@habemus-papadum/aiui-oscillator`](../oscillator) — instantiated in
  `src/model/store.ts` under two scopes (`scope("left")`, `scope("right")`). Each instance gets
  qualified controls (`left/freq`, `right/freq`), its own durable state, and its own agent tools
  (`left/kick`, `right/kick`).
- The `lissajous` cell (`src/model/graph.ts`) composes ACROSS the instances — slices are plain
  functions contributing cells to the app's one `hotCellGraph`.
- The slice's names, descriptions, and locs are compiler-injected across the workspace boundary
  (this app's compiler processes the linked package's source; locs come out dotdot-relative).
  Call `__app.call("report")` in the console to see the whole qualified surface.

Methodology write-up: the user guide's "Composing bigger apps" section.

An in-repo demo wired to the workspace (`workspace:^`, no npm install of aiui packages, no build
step). Run it from this directory:

```sh
pnpm dev      # this app (Vite)
```

Open the printed URL. The voice dock in the corner drives the page's own tools; it takes an OpenAI
key from `OPENAI_API_KEY` in the environment (the dev server hands it to the page) or from its own
key pane. See the [user guide](../../packages/aiui-viz/docs/frontend-user-guide.md).
