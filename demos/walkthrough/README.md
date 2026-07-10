# demo: walkthrough

The playbook, built step by step: 1-D heat diffusion, with every stage left standing as its own
page — pure functions (`/step1.html`), controls + cells (`/step2.html`), designed components
(`/step3.html`), the finished application (`/`).

**[WALKTHROUGH.md](./WALKTHROUGH.md) is the narration** — read it beside the code. The
methodology it demonstrates is the [frontend playbook](../../docs/guide/frontend-playbook.md).

Run the loop from this directory:

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
pnpm test     # the layer-1 physics + the headless layer-2 graph (stub worker)
pnpm exec vitest bench   # the numbers behind the "worker or not" decision
```
