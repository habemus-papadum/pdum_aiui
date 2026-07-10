# your app (an aiui starter)

A SolidJS app scaffolded by [`create-aiui`](https://habemus-papadum.github.io/pdum_aiui/), wired
for the aiui loop: a Claude Code session with a custom channel, a shared agent+human browser, and
a web intent tool floating over the page. The app you see on first run — a banner and a rose you
can play with — is **scenery, built to be rebuilt**: open the overlay and describe the app you
actually want.

> ⚠️ First read *Read before running* in the aiui docs: `aiui claude` can skip permissions and
> gives the agent a browser. This scaffold assumes you've decided to trust it.

## Run it

```sh
npm run claude   # terminal 1 — Claude Code with the aiui channel + session browser
npm run dev      # terminal 2 — this app (Vite + the intent tool overlay)
```

Then open the app **in the session browser** (the window you share with the agent):

```sh
npx aiui open http://localhost:5173
```

Arm the overlay with the backtick key `` ` `` (or the floating **✳ aiui** button), then talk:
hold **Space** and speak, drag to circle the thing you mean, or use the plain-text tab — then
**Enter** to send. What you say lands in the Claude session as a prompt, with screenshots and
source locations attached.

Optional but recommended: `direnv allow` activates `.envrc` — it puts `node_modules/.bin` on
your PATH (bare `aiui`, `vite`, `tsc`) and loads `.env`, where `OPENAI_API_KEY` belongs if you
want real voice transcription.

## What's what

The layout is the [frontend-for-agents](https://habemus-papadum.github.io/pdum_aiui/guide/frontend-for-agents)
methodology in miniature:

```
vite.config.ts        the ENTIRE aiui integration: one aiuiDevOverlay() plugin
src/
  model/store.ts      durable roots + the control surface (described, constrained knobs)
  model/rose.ts       pure math (the picture; playbook layer 1, with rose.test.ts)
  model/scenery.ts    the starter's demo cells + tools (layer 2, with scenery.test.ts)
  model/graph.ts      the disposable cell graph + the agent tool surface
  ui/                 components — freely hot-swappable
  main.tsx            entry: almost nothing (start reading there)
```

Try the starter's interactions before replacing them: drag the sliders and watch the picture
recompute through its cell. `npm test` runs the starter's example tests — pure math and a headless
cell probe — which double as the patterns for testing your own app.

Want a **blank canvas** instead of the rose? All scenery is fenced with `<aiui-scenery>` comment
markers; `CLAUDE.md` § *Reset to a blank canvas* gives the three-step mechanical deletion (any
model, however small, can follow it — no code reasoning involved).

This is a standalone git repo of your own — let the agent redesign, break, and rebuild
everything; nothing flows back anywhere.

Docs: <https://habemus-papadum.github.io/pdum_aiui/guide/getting-started>
