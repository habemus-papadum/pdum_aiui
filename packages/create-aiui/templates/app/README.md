# your app (an aiui starter)

A SolidJS + aiui-viz app scaffolded by
[`create-aiui`](https://github.com/habemus-papadum/pdum_aiui/tree/main/packages/create-aiui), with
the voice dock in the corner, ready for an agent to edit. The app you see on first run — a banner
and a rose you can play with — is **scenery, built to be rebuilt**: tell your agent the app you
actually want.

## Run it

```sh
pnpm install
npm run dev
```

Open the printed URL. The `aiui` pill in the corner is the voice dock: it expands into the voice
sessions, the page's tool log, a key pane and a source browser, and nothing connects until you
press one. Both voice engines want an OpenAI key — export `OPENAI_API_KEY` before `npm run dev`
and the dev server hands it to the page, or paste one into the key pane.

Optional but recommended: `direnv allow` activates `.envrc` — it puts `node_modules/.bin` on
your PATH (bare `vite`, `tsc`) and loads `.env`, where `OPENAI_API_KEY` belongs.

## What's what

The layout is the [frontend-for-agents](https://github.com/habemus-papadum/pdum_aiui/blob/main/packages/aiui-viz/docs/frontend-for-agents.md)
methodology in miniature:

```
vite.config.ts        the ENTIRE aiui integration: one aiui() plugin (source stamps)
src/
  model/store.ts      durable roots + the control surface (described, constrained knobs)
  model/rose.ts       pure math (the picture; playbook layer 1, with rose.test.ts)
  model/scenery.ts    the starter's demo cells + tools (layer 2, with scenery.test.ts)
  model/graph.ts      the disposable cell graph + the agent tool surface
  ui/                 components — freely hot-swappable
  styles.css          this app's own rules; the look is the design system (one import)
  main.tsx            entry: almost nothing (start reading there)
```

The page's look is `@habemus-papadum/aiui-design` — cotton paper, slate ink, editorial type,
and a skin for every component aiui-viz renders — imported once in `main.tsx`. Write your own
rules in `src/styles.css` (they win without specificity games), or delete that import and bring
your own sheet: the class names aiui-viz emits are the only contract.

Try the starter's interactions before replacing them: drag the sliders and watch the picture
recompute through its cell. `npm test` runs the starter's example tests — pure math and a headless
cell probe — which double as the patterns for testing your own app.

Want a **blank canvas** instead of the rose? All scenery is fenced with `<aiui-scenery>` comment
markers; `CLAUDE.md` § *Reset to a blank canvas* gives the three-step mechanical deletion (any
model, however small, can follow it — no code reasoning involved).

This is a standalone git repo of your own — let the agent redesign, break, and rebuild
everything; nothing flows back anywhere.

Docs: <https://github.com/habemus-papadum/pdum_aiui/blob/main/packages/aiui-viz/docs/frontend-user-guide.md>
