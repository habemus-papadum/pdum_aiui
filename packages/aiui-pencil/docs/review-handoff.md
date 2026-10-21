# Pencil status and recommended follow-ups

As of **2026-10-17**, pen drawing and canvas pinch zoom are usable in the tested
Wacom Movink 13 setup. The user accepted the latest behavior, including a brief
provisional mark disappearing when pinch starts. Touch navigation remains partly
unreliable, rotation has no usable browser input in the captured tests, and the
lab still emits reactive performance warnings. Pen latency has not been measured.

This handoff is for an independent review of the implementation and the next
steps. The immediate priority is preserving reliable pen input. A broader input
refactor should follow the hardware evidence; the performance cleanup can be
reviewed separately.

## Code and evidence baseline

- `fe5488e5` — `fix(pencil): handle Wacom pinch zoom and document browser input`.
  Contains the lab wheel handling, provisional mouse-draft cancellation, tests,
  and hardware evidence. Committed locally; this session did not push it.
- The earlier capture-loss fix and Pencil/Circle refactor are already in the
  baseline. `fe5488e5` does not contain all of that earlier work.
- `f7bcc10e` — prior shared `cell()` equality/status fix. Both the stable status
  boxes and output equality support were confirmed in the code served to the
  inspected browser. The remaining warnings do not establish a regression in it.
- No performance changes were implemented during the subsequent console review.
  Recommendations below remain open.

Start with [the Wacom input note](./wacom-browser-input.md), its
[recorded excerpts](./evidence/movink13-2026-10-17.json), and
[the library architecture](./architecture.md). The excerpts are partial evidence,
not complete event streams suitable for replay. Their original base commit is
the capture baseline, not the eventual commit of the compatibility fix.

The last inspected lab was `http://127.0.0.1:5340/` in the connected DevTools
browser. Discover the current tab and server rather than assuming their IDs or
ports persist. Check the current diff before making changes in this shared repo.

## Current status

| Area | Status and limit |
| --- | --- |
| Stroke lifetime | Capture loss alone no longer cancels a stroke. Document capture listeners continue active contacts through outside-canvas release. Hardware quick strokes and outside releases passed. Blur, disposal and disabling input can still cancel drafts. |
| Driver delivery | Resetting the Wacom driver resolved many earlier failures. An episode with no delivered pen events was distinct from the application cancelling a received stroke. Exact OS and driver builds were not recorded. |
| Canvas pinch | The lab prevents Ctrl+wheel browser page zoom and applies anchored ink/content zoom, bounded to scale 0.1–10. This compatibility handler is lab-specific, not supplied to every `PencilSurface` consumer. |
| Provisional marks | An active mouse-like draft can yield to pinch. Its input contact is cancelled, so later move/up cannot commit it. A mark committed before pinch is not removed. Brief previews remain possible. |
| Pen protection | Pinch preserves drafts containing pen-labelled samples, nondefault pressure, tilt or barrel evidence. Ordinary wheel scrolling does not have the same protection. |
| Rotation | The isolated Wacom twist produced mouse events and small marks, with no usable rotation angle. View rotation controls and synthetic touch-pair tests do not establish physical Wacom rotation support. |
| Navigation telemetry | Touch-policy counters omit wheel navigation. A zero touch zoom count can coexist with successful wheel zoom. |
| Performance | `HOT_SCOPE_TIME` and `UNSTABLE_MEMO_OUTPUT` remain. Their application causes need a controlled profile; they do not prove why strokes previously disappeared. |

Physical finger input arrived as mouse pointers and wheel events. Some physical
pen strokes also arrived as mouse pointers, but with varying pressure or tilt.
Pressure 0.5 alone cannot identify a finger. The pinch handoff predicate is an
ownership policy for ambiguous input, not a general Wacom classifier. Rejecting
all reported mouse input would reject some real pen input in this setup.

Latest hardware recovery phase: nine pen-labelled strokes committed, one
mouse-like draft cancelled at the first Ctrl+wheel event, no stranded draft,
409 pinch events and 128 ordinary wheel events, with page scale remaining 1.
Earlier phases included 25 quick strokes with varied pressure and four
outside-release strokes that remained. These are individual successful checks,
not a complete hardware sign-off; see the evidence note for phase boundaries.

## What the console review established

`HOT_SCOPE_TIME` reports summed compute time over a **1000 ms window**, with an
8 ms budget. The inspected messages ranged roughly from 8 to 16.5 ms and named
`inkSignals.snapshot` as the latest cause. They are performance warnings, not
exceptions or a measurement of each frame's latency.

`UNSTABLE_MEMO_OUTPUT` reported fresh but shallowly equivalent arrays on repeated
runs. The previous shared cell fix stabilizes internal status objects and gates
published values by equality. It does not prevent application computations from
running, nor automatically make their returned arrays stable.

The source shows three useful leads:

1. In [reactive.ts](../src/reactive.ts), `strokes()` and `live()` both read the
   same snapshot signal. Live appends publish at 15 Hz by default; discrete
   changes publish immediately. Completed records retain identity, but there is
   no memo boundary that stops a completed-stroke consumer waking on live changes.
2. In [graph.ts](../lab/src/model/graph.ts), `plans` maps every completed stroke
   through `planStroke()` on each invalidation. No current lab UI consumer was
   found; verify agent/report consumers before removing it. With no completed
   strokes, repeated fresh empty arrays are a plausible source of the unstable
   output warning. The warning has not been attributed to this cell conclusively.
3. `inkStats` runs `planStroke()` for the newest stroke just to read its densified
   path for area. [planStroke](../src/dabs.ts) also resamples and generates brush
   dabs. [processStrokeGeometry](../src/stroke-geometry.ts) provides the geometry
   without those brush calculations. Statistics also rescan completed records.

The existing attribution totals included a `cell.memo` with 442 runs and about
915 ms of accumulated self time. That is historical session data, including hot
reloads, not a controlled benchmark. Several cells share the name `cell.memo`,
so it cannot identify the expensive cell by itself. The renderer and diagnostic
overlay already have their own revision-based caches; do not infer that all
rendering is uncached from the lab graph's behavior.

## Recommended review checklist

The order below is a recommendation for the reviewer, not a requirement to
implement a broad refactor in one change.

- [ ] **1. Establish a reproducible baseline.** Review `fe5488e5`, the current
  source and the evidence qualifications. Capture a bounded drawing interval
  with completed-stroke count, live sample count, enabled overlays, cell run
  counts and compute time. Repeat with empty ink, many completed strokes and a
  long live stroke. Separate startup/HMR history from the measured interval.
  Identify the actual expensive cells before claiming a cause or improvement.
- [ ] **2. Close the ordinary-wheel pen protection gap.** Trace
  [scene.ts](../lab/src/model/scene.ts) through scroll synchronization into
  `paper.setViewport()`. Ordinary scrolling can currently cancel active local
  input, while Ctrl+wheel checks pen evidence first. Decide and test one
  ownership rule across both channels, including mouse-labelled pen evidence,
  disabled navigation and linked/unlinked content. Verify that scroll followed
  by pinch still removes eligible provisional ink without losing real pen ink.
- [ ] **3. Remove or justify the `plans` cell.** Confirm whether the UI or agent
  surface needs it. Remove it if redundant; otherwise cache unchanged records
  and invalidate only for relevant changes. Verify both empty-canvas drawing and
  a document with many completed strokes. A completed stroke should not be
  replanned because another stroke receives a new point.
- [ ] **4. Narrow reactive invalidation.** Derive a stable completed-stroke
  selection from the coherent snapshot before expensive consumers run. Preserve
  coherent snapshot reads, revision changes and disposal ownership; introducing
  separately published signals must not expose mismatched live/completed state.
  Test that appends do not wake completed-only consumers, while commit, clear,
  undo/redo, erasure and profile edits still reach the consumers that need them.
- [ ] **5. Reduce statistics work.** Use geometry-only processing for area and
  cache completed statistics by record identity/revision and relevant geometry
  inputs. Preserve the current meaning of area and length. Verify equivalent
  values and correct invalidation on edits; inspect long-stroke cost separately.
  Output equality can reduce downstream updates but cannot recover time already
  spent recomputing the result. Do not start by suppressing warnings or adding
  deep comparisons over large plans.
- [ ] **6. Improve diagnostic attribution.** Pass the qualified cell identity
  into the underlying Solid memo's diagnostic name, subject to the installed API.
  This is a possible small shared `aiui-viz` change, separate from Pencil fixes.
  Confirm warnings and profiles identify cells such as `pencil-lab/inkStats`.
  Keep the existing cell status and output equality semantics intact.
- [ ] **7. Recheck performance and hardware behavior.** Compare equivalent
  workloads before/after with named computation counts and timings. Preserve
  warnings as evidence of remaining costs. Repeat quick/light pen strokes,
  outside releases, staggered fingers, mixed scroll/pinch and immediate pen
  recovery. Check committed ink, active drafts, viewport and page zoom together.
- [ ] **8. Plan the larger input revision from captured data.** Add bounded raw
  event capture/export, then replay complete streams through a shared pure
  pointer/wheel ownership policy. Keep reported device kind, pen evidence and
  interaction ownership distinct. Correlate wheel and touch navigation telemetry.
  Resolve rotation through a demonstrated input source or an explicit alternate
  control; do not promise a browser setting or native bridge will solve it.

No timer should delay pen start. Preserve every accepted real sample, exclude
predictions from committed ink, and keep capture loss distinct from cancellation.
Cancelled provisional contacts must never commit on a later release. View
changes must not rewrite source samples. Optimize observation work without
reducing pen sampling or making diagnostics part of synchronous pen handling.

## Validation and commands

At the compatibility implementation, **245 unit tests**, **three selected
Chromium regressions**, package/lab typecheck, and changed-file Biome checks
passed. The commit hook also passed. The selected browser cases cover capture
loss, browser-delivered touch navigation and Ctrl+wheel with pen protection and
mouse-draft cancellation. The full browser suite was not run in that final pass.
These results do not certify Wacom driver delivery or end-to-end latency.

From the repository root:

```sh
pnpm -C packages/aiui-pencil test
pnpm -C packages/aiui-pencil typecheck
PENCIL_TEST_PORT_BASE=5451 pnpm -C packages/aiui-pencil test:browser --grep 'Ctrl\+wheel|capture loss|wide finger'
```

The browser runner starts three servers on the base port and the next two ports;
choose unused ports and leave the user's hardware-test server intact. Run
`pnpm -C packages/aiui-pencil test:browser` for the complete browser suite when
the proposed change warrants it. For manual work, reuse the live lab or launch:

```sh
pnpm -C packages/aiui-pencil lab --host 127.0.0.1 --port 5340 --strictPort
```

Read the installed Solid reactivity diagnostic guide before changing the graph.
In the inspected runtime, `costs` and `feedback` are **named exports** from
`solid-js/attribution`; `attribution.enable()` controls recording. Check the
installed API rather than assuming the guide's `attribution.costs()` spelling.
Avoid per-move console logging. Measure pen latency with diagnostic recording
disabled, and report that measurement separately from reactive compute budgets.

After review, record confirmed causes, chosen policy changes, before/after
measurements and remaining hardware questions here. Add new device observations
to the Wacom evidence note so future reviews can distinguish observed behavior
from proposed architecture.
