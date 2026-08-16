# demo: regimes — which error owns your loss?

A live research-notebook demo that teaches, step by step, how to think about
fitting models to data — built from a conversation about signal-to-noise,
ensembling, and "all data is some computer simulation" (the transcript is in
[NOTES.md](./NOTES.md)).

The through-line: *"how hard is this data?"* has no answer until you fix two
things — **which game** you are playing (predict the next value, or predict its
distribution) and **which term** of

> loss = noise floor + approximation + estimation + optimization

you are actually losing to. Each section stages one concept on the smallest
honest simulator that exhibits it — a loaded die, a wiggly curve plus Gaussian
noise, an exactly-solved gradient flow, the logistic map — with every number
measured live from freshly generated data.

Run it from this directory:

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
```

Then open the printed localhost URL in the session browser (`../../bin/aiui open <url>`),
activate the intent client (**⌘B**), and ask about anything you see — the page's
controls, cells, and actions are all exposed as agent tools (`window.__regimes`).
