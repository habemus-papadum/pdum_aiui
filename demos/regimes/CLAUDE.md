# demo: regimes

A teaching notebook that unpacks one conversation about fitting models to data
(the transcript rides along as [NOTES.md](./NOTES.md)) into seven live sections,
each staged on the smallest honest simulator that exhibits its concept:

1. **§1 two games** — pointwise vs distributional prediction, scored on a loaded
   die (the RNG paradox dissolved).
2. **§2 the floor** — y = f(x) + σε; signal (Var f), floor (σ²), SNR.
3. **§3 the master equation** — loss = floor + approximation + estimation +
   optimization, measured by Monte-Carlo refits; the regime verdict.
4. **§4 ensembling** — MSE vs ensemble size M; only the estimation term shrinks;
   disagreement as the truth-free diagnostic.
5. **§5 spectral bias** — gradient flow solved exactly in the kernel eigenbasis;
   scrub training time, watch coarse modes learn before fine.
6. **§6 horizon** — the logistic map at r = 4: pointwise forecasting dies at
   λ = ln 2 per step, the invariant (arcsine) density lives forever.
7. **§7 the laws** — the diagnostic procedure for data whose truth you don't know.

A real, maintained demo — **not** starter scenery. Every number on the page is
computed live from its controls; nothing is quoted.

## Run the loop

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
```

## Layout (the playbook's layers)

- `src/model/rng.ts` · `dice.ts` · `regress.ts` · `spectral.ts` · `chaos.ts` —
  layer 1: pure, realm-free math, one module per simulator, unit-tested
  (`*.test.ts`). Calibration facts the tests pin: a Chebyshev fit of sin(ax)
  needs degree ≈ a (hence the 4πx fine wiggle and the degree-14 slider cap);
  ensemble gains are asserted **in expectation** (averaged over seeds) because a
  single member's MSE is a noisy draw; degree ≳ 12 on small n is deliberately
  ill-conditioned — the estimation term exploding to 10³+ is the overfitting
  story, not a bug.
- `src/model/store.ts` — the curated control surface (all scoped under
  `appScope = scope("regimes")`) plus the durable Monte-Carlo `seed`.
- `src/model/graph.ts` — one thin cell per panel (die, decomp, world, ens,
  spectral, chaos), the `reseed` action/helper, `registerStandardTools`
  (`window.__regimes`). Per-input probes in `graph.test.ts`.
- `src/ui/` — one panel component per section, Observable Plot via
  `aiui-viz/plot`; `App.tsx` is the paper-shaped page (TocRail, TeX, prose,
  experiment lists naming exact controls).
- Page CSS is `src/page.css`, **scoped under `.regimes`**; shared chrome comes
  from `@habemus-papadum/aiui-journal` (imported by `main.tsx` standalone, by
  the shell in the gallery).
- `src/card.tsx` — landing card: three precomputed regimes of the stacked bar,
  pure model only (no store/graph).

## Ground rules

- **Everything is scoped** under `appScope` — controls, cells, the action, the
  graph key, the toolkit. Thread it into every new declaration.
- **Keep the prose honest.** Each section's claims are exactly what its panel
  computes; if you change a simulator, re-read the section text (and NOTES.md)
  for statements that stop being true.
- **Don't remove the integration.** The `aiui()` plugin in vite.config.ts
  stamps source locations; never hand-write `data-source-loc`/`data-cell-loc`.

Methodology docs: <https://habemus-papadum.github.io/pdum_aiui/guide/frontend-user-guide>
