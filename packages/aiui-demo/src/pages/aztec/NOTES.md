# aztec — build notes & findings

The second notebook page: uniformly-random domino tilings of the Aztec diamond
by **EKLP domino shuffling**, the arctic-circle phase transition, and the
tilings-as-permanents connection. Built to the methodology in
[`../../../PRINCIPLES.md`](../../../PRINCIPLES.md); this file records what the
build taught, for folding back into that document.

## What it exercises (all from PRINCIPLES)

- **Level-1 multi-page** (§8): its own `aztec.html` entry → `main.tsx`, a fresh
  window, its own durable registry, its own `window.__aztec` tool namespace. A
  full page load per notebook is the resource policy — leaving frees the worker
  and the rAF player by construction.
- **Durable roots / disposable logic** (§2): the canvas, the frame ring, the
  shuffle worker, the animation player, and the user's controls live in
  `store.ts`; the cell graph and every component are rebuilt over them. Verified
  live: a component edit (and a graph edit) hot-swap while the grown n=64 tiling,
  the playhead, and the controls all survive.
- **Cells for async dataflow** (§1): the growth run is a `cell` over the worker
  stream, so progress and cancel-by-supersession come free — dragging the order
  slider mid-grow aborts the worker and restarts.
- **Imperative island + cadence bridge** (§3): the rAF `player` walks the
  playhead through the ring at the chosen fps and writes one `frameIndex` signal;
  a graph effect is the reactive→imperative seam that repaints the canvas. The
  60 Hz loop never touches the graph except through that one signal.
- **Worker choreography** (§4): macrotask yields between growth steps so
  `cancel` is seen, streamed partials (a frame per step), progress = n/target,
  errors posted as a retryable cell state.
- **Agent tool surface** (§5): `window.__aztec` — `set-size`, `regrow`/`run`,
  `play`/`pause`, `set-speed`, `toggle-circle`, `seek`, `locate`, and a bounded
  `report()`. The whole live verification was driven through it.
- **Validated palette** (§6): four categorical domino colors, below.

## Findings to fold into PRINCIPLES §7 (Solid 2.0 / toolchain)

1. **`createEffect(source, handler)`: the handler is not a tracking scope.**
   §7 already notes the compute/handler split for *writes*; the *read* side bit
   us too. Reading a signal directly in the handler warns
   `STRICT_READ_UNTRACKED` (it fired ~100×/second here) and, in principle, can
   miss updates — the handler must consume the value the source produced. The
   render bridge went from `(...) => draw(…, frames.at(frameIndex.get()))` to
   `(s) => draw(…, frames.at(s.i))` and the warning vanished.

2. **Signal writes are transactional within a synchronous tick — a `get()` in
   the same tick as a `set()` may not observe the write.** This surfaced two
   ways: (a) an agent tool that does `x.set(v); return x.get()` can return the
   *pre-write* value (fixed by returning the value it computed, see `seek`); and
   (b) verifying via `evaluate_script`, a synchronous `report()` right after a
   tool `set` reads stale — you must let a task boundary (`await` a `setTimeout`)
   flush the batch before reading. Cross-task reads were always correct; only
   same-tick reads lied. Cost me a long false-alarm chase into a "seek is broken"
   that wasn't. (Notably `targetN`/`fps` re-reads *did* look fresh — the effect
   is most visible on a heavily-subscribed signal like the playhead.)

3. **HMR boundary: editing the *worker* or a *store* module forces a full page
   reload**, which resets the durable registry (fresh window). Editing
   components or the graph module hot-swaps and preserves durable state. Practical
   rule when driving a live page: don't edit `*.worker.ts` / `store.ts` mid-run,
   or the grown state resets under you. (This is the durable/disposable line
   showing through the tooling: the worker and the durable roots are *durable*,
   and Vite can only preserve them by not touching their modules.)

4. **The durable-canvas island generalizes past WebGL.** The exact SimCanvas
   pattern — element + 2D context created in `store.ts`, adopted by a ref
   callback, cleanup that un-parents *only if still mine* — works unchanged for
   canvas-2D. The draw code lives in a disposable module (`render.ts`) so color
   and overlay edits repaint the current tiling without disturbing the durable
   canvas.

5. **One worker, two request kinds, two cells.** A discriminated `run` payload
   (`{kind:"shuffle"|"permanents"}`) lets one durable worker serve both the
   growth stream and the Ryser permanent check; `workerStream`'s per-request `id`
   demuxes concurrent runs cleanly, and the permanent result is cached worker-side.

6. **Duplicate-final-frame gotcha.** Emitting the final order as *both* a
   streamed partial and the `done` value double-records it in the ring (65 frames
   for n=64). Gate the partial on `t.n !== targetN` and let `done` carry the last.

## Palette (dataviz skill, validated)

Four categorical domino colors, fixed assignment, validated against the dark
panel surface `#171b25` (all in OKLCH L 0.48–0.67, chroma floor cleared, worst
adjacent CVD ΔE 31.2, contrast ≥ 3:1):

| type | color   | corner it freezes into |
| ---- | ------- | ---------------------- |
| N    | #4a86dd | north (top), horizontal |
| E    | #c9822f | east (right), vertical  |
| S    | #2fa876 | south (bottom), horizontal |
| W    | #9b6fdb | west (left), vertical   |

Identity is not color-alone: the legend pairs each swatch with the type letter
and its movement, and the brickwork orientation is a second channel.

## The math, and how it's checked

- **EKLP shuffling** (`shuffle.ts`): a tiling is a list of typed dominoes on a
  (2n)×(2n) grid. Growth = destruct (delete facing 2×2 blocks) → slide (a fixed
  anchor remap composing the concentric embed with a one-cell move) → create
  (greedy row-major fill of the vacated 2×2 holes by fair coins). Unit-tested:
  tiling validity preserved through 40 orders and across seeds, domino count
  n(n+1), determinism under a seeded mulberry32, and the `create` guard against
  an ill-formed hole.
- **Arctic circle**: `frozenFraction` = fraction of dominoes whose center is
  *outside* the inscribed circle (radius n/√2) and whose type matches its corner.
  → 1 as n grows (a thin boundary layer at the circle keeps it just under 1 at
  finite n); the temperate interior stays genuinely mixed (all four types
  present) — both asserted in tests.
- **Permanents** (`permanent.ts`): #tilings = #perfect matchings of the dual
  bipartite graph = permanent of the black×white biadjacency matrix, computed by
  Ryser (Gray-code, O(2^m·m)). Unit-tested to equal 2^(n(n+1)/2) = 2, 8, 64, 1024
  for n=1..4.

## Mapping shuffling onto the GPU (not implemented — CPU worker suffices to n≈96)

Each of the three phases is data-parallel over the aligned 2×2 blocks of the
grid, which is exactly why the Julia `AztecDiamonds.jl` package expresses it with
`KernelAbstractions.jl` (one kernel per phase, backend-agnostic CPU/CUDA/Metal):

- **destruction** — a kernel over 2×2 blocks marks each facing pair (S-over-N,
  E-left-of-W) for deletion; independent per block.
- **slide** — each surviving domino's new cell is a pure function of its old cell
  and type (the anchor remap in `slideGrow`): a scatter into a fresh, larger
  grid. Double-buffer to avoid read/write hazards.
- **creation** — each vacated 2×2 block is filled independently by a *coin*; to
  keep it deterministic and parallel, drive the coin from a **counter-based RNG**
  (philox/threefry) seeded by `hash(blockCoord, step, globalSeed)` rather than a
  sequential stream. No inter-thread communication.
- **frozen fraction** is a parallel reduce; **rendering** can draw instanced
  quads straight from the cell-type buffer.

A **WebGPU** port would need: the grid as a `GPUBuffer`/storage texture; three
WGSL compute shaders dispatched over the block grid; a WGSL counter-based RNG for
the creation coins; double-buffering across the slide→create hazard; and
(optionally) an instanced render pipeline reading the buffer directly, so the
tiling never leaves the GPU. The grid (vs. a domino list) representation is the
enabler — it removes the stream-compaction step a list would force after
destruction. Left unbuilt deliberately: at n≤96 the pure-TS worker grows and
streams frames faster than the animation plays them.
