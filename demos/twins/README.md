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
step). Run the loop from this directory:

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
```

Then open it in the session browser — the window you share with the agent:

```sh
./aiui open http://localhost:5173   # from the repo root
```

Arm the overlay with the backtick key `` ` `` (or the floating **✳ aiui** button) and describe
what you want. See [docs/guide/getting-started.md](../../docs/guide/getting-started.md).
