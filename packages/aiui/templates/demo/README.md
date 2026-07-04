# aiui demo playground

A disposable sandbox for trying [aiui](https://habemus-papadum.github.io/pdum_aiui/): a Claude
Code session with a custom channel, a shared agent+human browser, and a web intent tool floating
over a demo app. It's a local git repo of its own — let the agent redesign, break, and rebuild
the app; nothing flows back anywhere.

> ⚠️ First read *Read before running* in the aiui docs: `aiui claude` can skip permissions and
> gives the agent a browser. This sandbox assumes you've decided to trust it.

## Run it

```sh
npm run claude   # terminal 1 — Claude Code with the aiui channel + session browser
npm run dev      # terminal 2 — the demo app (Vite + the intent tool overlay)
```

Then open the app **in the session browser** (the window you share with the agent):

```sh
npx aiui open http://localhost:5173
```

Click the floating **✳ aiui** button, type an intent — *"make the baseline curve red"* — and
watch it land in the Claude session as a prompt. The 🔍 button shows how your input was lowered
into that prompt.

## What's what

- `vite.config.ts` — the **entire** aiui integration: one `aiuiDevOverlay()` plugin. This is the
  part you'd copy into your own app.
- `src/main.ts` — throwaway scenery (a fake spectrum viewer). No aiui code in it.
- Re-running the scaffold command in this directory just picks up where you left off — it never
  overwrites your (or the agent's) changes.

Docs: <https://habemus-papadum.github.io/pdum_aiui/guide/getting-started>
