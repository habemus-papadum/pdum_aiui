# demo: DNA scripts

A shape notation for DNA sequences. Instead of the letters A/T/G/C, each base is a glyph whose
form carries the biology, so two things you normally have to *work out* become things you can
*see*:

- **complementarity** — complementary bases interlock, one's tooth filling the other's socket;
- **reverse-complementarity** — set a strand against its partner, turn the partner 180°, and the
  whole duplex zips shut.

## The notation

Three features encode a base:

| | bump family | polarity | solid half |
| --- | --- | --- | --- |
| **A** | round | tooth | top |
| **T** | round | socket | top |
| **G** | angular | tooth | bottom |
| **C** | angular | socket | bottom |

Complements share a family (so they mesh) and oppose in polarity (so one fills the other). They
also share a solid half — and because turning the partner strand moves its solid to the opposite
side, **A·T pairs read hollow through the middle and G·C pairs solid across it**. A GC-rich
stretch is visibly denser, which is also the stretch that is harder to pull apart.

A reverse palindrome (`GAATTC`, `GGATCC`) is exactly a duplex with 180° rotational symmetry —
which is what makes it visible at a glance rather than something you check base by base.

### Why the edges are guaranteed to mesh

Drawing a strand on top and its reverse complement below-and-turned puts `rot180(glyph(comp(sᵢ)))`
at position *i*. Rotating a cell about its centre maps `(x, y) → (W − x, H − y)`, so writing the
pairing edge as `H + polarity · amp · s(x)` for a bump `s` symmetric about the cell centre, the
two curves coincide exactly when complements share a family and oppose in polarity. Both members
of a pair come out of one parameterised path builder with the sign flipped, so a tooth and its
socket cannot drift apart the way two hand-drawn paths would — and `src/model/glyph.test.ts`
checks it numerically on the sampled curves that actually get rendered.

## Folding

A duplex needs two strands; a fold needs one. A strand pairs with itself wherever some stretch
meets a later stretch that is its reverse complement — and **the fragment as a whole need not be a
palindrome**. Only the two arms have to match; whatever sits between them is left over as a loop.
`GGGGATTTCCCC` is the plain case: `GGGG` and `CCCC` close around an `ATTT` loop, and the twelve
bases together are not a palindrome at all.

Once the arms need not abut, finding the pairing is a *search*, not a reading, so the fold is
computed:

- **`fold.ts`** runs Nussinov maximum-pairing (O(n³)) weighted so G·C outscores A·T, then discards
  helices shorter than `minHelix`, because maximising a count rewards lone pairs that stack on
  nothing. It decomposes the result into loops — hairpin, stack, bulge, internal, multi, exterior.
  Pairing is Watson–Crick only, which is right for DNA and also keeps the notation honest: every
  reported pair is one the glyphs can actually draw interlocked.

  **This is a toy folder, not a thermodynamic one** — no stacking or loop-entropy parameters, so it
  will sometimes propose a structure no real molecule would adopt. It earns its place by making the
  notation work on arbitrary input, not by predicting biology.

- **`foldLayout.ts`** is the classic radiate construction. A helix is a straight ladder — the flat
  duplex, rotated — so the teeth mesh for the same reason they do there. A loop is a circle through
  its bounding bases, whose radius solves

      nH · 2·asin(H/2r) + nW · 2·asin(W/2r) = 2π

  (`nH` pair chords of length `H`, `nW` backbone steps of length `W`; bisected, no closed form).
  Branches leave along the outward radius.

  Two things the layout deliberately handles or admits. The chord equation treats bases as *points*
  — every RNA drawing program does, because it draws a letter. Ours are cells `H` tall standing
  radially, so a small loop solves to a radius *smaller than the cells on it* and they pile up on
  the centre; `MIN_LOOP_RADIUS` opens such loops and shares the slack among the backbone gaps,
  keeping pair chords exactly `H`. And there is **no relaxation pass**, so separate branches can
  still overlap — `overlappingPairs` reports it and the UI says so rather than presenting a tangle
  as fact.

## Layout

- `src/model/dna.ts` — sequence algebra: complement, reverse complement, palindromes, stems.
- `src/model/glyph.ts` — the geometry: profiles, path builders, duplex layout.
- `src/model/fold.ts` — secondary structure: folding, helices, loop decomposition, dot-bracket.
- `src/model/foldLayout.ts` — placing a folded strand: radiate layout.
- `src/model/store.ts` — the control surface (`sequence`, `rotatePartner`, `showLetters`,
  `glyphSize`, `minLoop`, `minHelix`, `foldSize`).
- `src/model/graph.ts` — the cells (`strand`, `duplex`, `folded`) and the actions (`flip`,
  `loadExample`).
- `src/ui/` — `Glyph`/`Strand` (inline), `Duplex` (the flat figure), `FoldFigure` (the folded one),
  `GlyphKey` (the alphabet).

## Running it

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
```

Then open it in the session browser — the window you share with the agent:

```sh
./aiui open http://localhost:5173   # from the repo root
```

Activate the intent client (**⌘B**) and describe what you want. See
[docs/guide/getting-started.md](../../docs/guide/getting-started.md).

## Open questions

- **Font or SVG?** SVG for now: the two-tone fill is load-bearing, and colour is exactly what a
  plain font cannot carry. A colour font (COLR/CPAL) would be the way to get real text shaping.
- **A relaxation pass for the layout.** Branches of a multiloop can still collide; the standard fix
  is to push subtrees apart iteratively (naview does this). Today the app only *reports* collisions.
- **A real energy model.** Swapping Nussinov for a Zuker/Turner nearest-neighbour model would make
  the predicted structures trustworthy rather than merely well-formed.
- **Folding in a worker.** The O(n³) search is capped at `MAX_FOLD` = 160 bases to keep the main
  thread responsive; a worker would lift that.
- **Pseudoknots.** Excluded by construction — a nested table is what makes the structure a tree and
  therefore drawable by this layout.
