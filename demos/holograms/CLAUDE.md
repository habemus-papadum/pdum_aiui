# demo: holograms

The holography notebook: a virtual optical bench with two phases — RECORD
(laser split into reference + object arms; the film integrates |E|²) and
PLAYBACK (the developed film re-lit by the reference alone; the object's
wavefront comes back). Taught at design level: the kit's failure modes
(coherence/path-matching, vibration), the film's memory mechanism (grains →
develop → bleach, emulsion resolution as an angular-bandwidth budget), the
three playback beams and off-axis separation, cut-the-film (window, not
picture — with the honest costs), an eye on a rail (real parallax and
accommodation, computed from the wavefront), and playback remixes (λ-swap
depth scaling — Gabor's magnification — angle steering, curved-reference
projection). Everything runs on `@habemus-papadum/aiui-optics`; the paraxial
"ghost" overlays are the designer's equations (holo.ts) drawn over the honest
wave. A real, maintained demo — **not** starter scenery. The on-ramp is
`demos/gratings`.

## Run it

```sh
pnpm dev      # Vite; the voice dock takes OPENAI_API_KEY from the environment
```

## The dual shape (app + library)

- `src/main.tsx` — standalone entry: design-system chrome + `./page`.
- `src/page.tsx` — the `SitePage` the gallery mounts (via the `aiui.sitePage`
  marker). Page styles in `src/page.css`, scoped under `.holograms`.
- `src/card.tsx` — the landing `DemoCard`: a live record-bench miniature
  (plane wave × point glow, standing fringes) from the pure engine only.
- `src/index.ts` — the library barrel: scope, graph, App, and the pure bench
  pipeline (`exposeBench`/`developBench`/`beamSplit`/`ghostPredictions`, …).

## Structure

- `src/model/store.ts` — the control surface (bench phase, reference
  geometry, kit failure knobs, darkroom, scissors, eye, playback remixes) +
  `scenePoints` (a durable, NOT a control — tests must reset it by hand).
- `src/model/bench.ts` — playbook layer 1: the record→develop→playback
  pipeline over aiui-optics + the design readouts. `bench.test.ts` holds the
  physics claims (bleach ≈ 5× image efficiency per-incident, coarse emulsion
  strips the image, parallax: the in-focus point holds still while near
  points slide against the eye).
- `src/model/graph.ts` — the darkroom pipeline AS the cell graph:
  exposure → developed → cut → {maps, eye, split, ghosts}. Map cells stream
  from one durable worker (`map.worker.ts`, same seam as demos/gratings).
- `src/ui/` — `HoloBench` (the phase-switched star, draggable scene points),
  `FilmPanel` (exposure/grains/developed strips), `KitPanel`, `PlaybackPanel`
  + `RemixPanel`, `RetinaChart`, shared overlay helpers in `overlays.tsx`.

## Ground rules

- **Everything is scoped** under `appScope = scope("holograms")`; toolkit at
  `window.__holograms` (actions: movePoint/addPoint/removePoint/resetBench).
- **Physics honesty is the product.** The reference sits at 22° by default
  because the *eye* needs the defocused zero-order patch outside its view —
  the same off-axis design rule the page teaches; retina views carry real
  speckle (coherent crosstalk between point PSFs), so tests assert local
  peaks with speckle-sized tolerances, and magnitude claims live on far-field
  integrals (the `split` cell), not retina peaks.
- **The engine belongs to `demos/optics`** — new physics goes there, tested.
- **Don't remove the integration.** The `aiui()` plugin in vite.config.ts
  stamps source locations; the locator also runs under Vitest.

Methodology docs: [the user guide](../../packages/aiui-viz/docs/frontend-user-guide.md).
