# demo: gallery

**morphogen** — a Turing-pattern laboratory, and the reference app for this repo's
reactive-frontend methodology. Gray-Scott reaction-diffusion runs on the GPU (WebGL2,
SolidJS 2.0 beta); everything downstream of it — live observables, a worker-based
structure analysis, a streaming regime catalog, an interactive (F, k) atlas — is an
Observable-style **cell graph** over the running simulation. Never published — it exists
to be run, poked at, and extended.

Two things live here on purpose:

1. **The demo app** — deliberately rich: slow cancellable computations with progress,
   streaming partials, a simulated failing download with retry, plots (Observable Plot),
   a d3 parameter atlas, a table, pointer painting, and an agent tool registry at
   `window.__morpho` (`.tools`, `.call(name, args)`, `.report()`).
2. **[PRINCIPLES.md](./PRINCIPLES.md)** — the methodology discovered while building it:
   cells for async dataflow, the durable-roots/disposable-logic HMR contract, imperative
   islands with cadence bridges, worker choreography, the agent tool surface, and the
   Solid 2.0 / Vite HMR / LocatorJS findings, each paid for with a real bug. Read it
   next to the code; the file layout *is* the methodology.

It is also still the playground for the [web intent tool](../../docs/guide/web-intent-tool.md):
the `aiuiDevOverlay()` plugin in `vite.config.ts` mounts the widget — nothing in app code.

## Run it

```sh
# terminal 1 — a Claude Code session with the channel attached
./aiui claude

# terminal 2 — this app, served by aiui vite (injects VITE_AIUI_PORT)
pnpm demo
```

Open the printed URL **in the session browser**. Drag on the field to paint chemical V,
click around the regime atlas (mitosis is a good show), watch the analysis stream in.
The **✳ aiui** button sends intent into the session; the **🔍** button opens the
lowering-trace debugger.

Also works without a channel (`pnpm -C demos/gallery dev`): the app
runs fully; only the intent widget reports it has no port.

## Things worth trying

- Move the **thoroughness** slider while an analysis runs — the in-flight worker run is
  cancelled (really: the worker stops) and the panel keeps the last result, dimmed.
- Tick **fail next fetch**, hit **re-download**, then **Retry** — the whole
  progress/error/retry affordance is cell chrome, not bespoke panel code.
- Edit `src/sim/shaders.ts` while a pattern cooks — the GLSL recompiles in place and the
  field survives (`[morpho:hmr]` lines in the console narrate what was preserved).
- From the console: `__morpho.call("jump-regime", { id: "uskate" })`, then
  `__morpho.report()` — or `__morpho.call("locate", { selector: ".tile" })` to map
  anything on screen back to its source line.

## Publishing the static site

`pnpm run publish` (from this demo) builds both notebooks (base `/aiui/`) and dry-runs an
`aws s3 sync` to `s3://habemus-papadum.net/aiui`; add `--publish` (or `PUBLISH=1`) to upload for
real and invalidate the CloudFront cache. Live at <https://habemus-papadum.net/aiui/>. Uses the
`personal` AWS profile (override with `AWS_PROFILE`). Note it must be `pnpm run publish` — bare
`pnpm publish` is the npm registry command, which this private package refuses.

## What to look at

- `vite.config.ts` + `babel-source-locator.mjs` — the aiui integration and the
  source-location stamps (`data-source-loc="src/…:line:col"` on every element).
- `src/model/store.ts` vs `src/model/graph.ts` — the durable/disposable split.
- `PRINCIPLES.md` — why everything is shaped the way it is.
- Traces land in `.aiui-cache/` under wherever `aiui claude` ran (gitignored).

## The aztec page

A second notebook page (`aztec.html` → `src/pages/aztec/`) demonstrating the
multi-page pattern from [PRINCIPLES.md](./PRINCIPLES.md) §8: **uniformly-random
domino tilings of the Aztec diamond**, grown by EKLP domino shuffling. Watch the
fold and the **arctic circle** emerges — four corners freeze into single-orientation
brickwork (N/E/S/W dominoes) around a disordered disc of radius n/√2. A live panel
computes the number of tilings two ways — Ryser's **permanent** of the dual graph's
biadjacency matrix vs. the EKLP closed form 2^(n(n+1)/2) — and they match through
n=4. Same methodology as morphogen: a durable canvas island, a worker streaming a
frame per growth step into a scrub ring, a cell for progress/cancel, and an agent
surface at `window.__aztec` (`set-size`, `regrow`, `play`/`pause`, `set-speed`,
`toggle-circle`, `seek`, `report()`). Nav between the two pages is a plain link —
a full page load per notebook is the resource policy. Build notes and the
GPU/WebGPU mapping are in `src/pages/aztec/NOTES.md`.
