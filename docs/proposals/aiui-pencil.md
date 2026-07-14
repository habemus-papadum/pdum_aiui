# aiui-pencil: one instrument, three surfaces

Status: **proposal** — design committed to writing, no code yet (July 2026). Supersedes
[`@habemus-papadum/aiui-ink`](/packages/aiui-ink/) and
[`@habemus-papadum/aiui-paint`](/packages/aiui-paint/) outright. Companions:
[Element Capture & the Capture Plane](./element-capture-and-the-capture-plane.md) (which already
condemned `compositeInto`), [iPad Paint Stream](../guide/paint-stream.md) (what the streaming half
does today), the [frontend playbook](../guide/frontend-playbook.md) (the four layers the Lab is
built in), and [the mode engine](./intent-client/01-mode-engine.md) (whose bar projection the iPad
command bus turns out to already be).

## The ask

Three things, in this order:

1. **A pencil worth drawing with.** Not a paint program and not a brush library — *one* instrument
   with enough dynamic range that pressure, tilt, and orientation do the work a menu of brushes
   would otherwise do. Held upright and pressed lightly it writes; laid over, it broadens into
   charcoal. It has grain, because a mechanical pencil on paper has grain. Erasing is erasing —
   pixels come off.
2. **A lab to tune it in.** A dev server on the Mac, browsed from the iPad, where the aesthetics
   get decided by drawing rather than by reasoning. A real SolidJS app built to the playbook, not
   a scratch page.
3. **A remote pencil, and a command bus with it.** The iPad draws on a desktop browser and the
   authoritative image is the *screen capture*, not the local stroke — so the local stroke can be
   approximate, and must be *provably* transient. And the iPad should not merely mirror: it should
   see the app's modal command bar and be able to drive it.

Everything `aiui-ink` and `aiui-paint` do today has to keep working, because the Chrome extension
depends on it — including, crucially, **strokes that fade**.

## Why this is a rewrite and not a patch

The existing code is sound for what it was asked to do, and the wrong shape for what we now want.

`InkSurface` (`packages/aiui-ink/src/ink-surface.ts`) is a **retained vector renderer**: it holds a
list of strokes and, every animation frame, clears the canvas and re-strokes all of them as
smoothed polylines. That choice buys the fade for free — a stroke's opacity is a pure function of
its age, evaluated at draw time — and it costs everything else:

- **Width is per-stroke, not per-point.** `drawStroke` sets `ctx.lineWidth` once from
  `pressureWidth(stroke.width, averagePressure(points))` — the mean pressure over the entire
  stroke — and issues a single `ctx.stroke()`. Per-point pressure is captured and then averaged
  away. There is no mechanism by which a stroke can vary along its length.
- **There is no texture, and no room for one.** A stroked path is a stroked path.
- **There is no eraser, anywhere.** Not in `InkSurface`, not in `PaintIntent`
  (`packages/aiui-paint/src/protocol.ts:64`), not as undo. Removal means `clear()` — all of it.
- **Smoothing rounds off cusps by construction.** `smoothedSegments` uses raw samples as quadratic
  control points and midpoints as endpoints. Ideal for a lasso around a chart; destructive to the
  sharp reversals that distinguish an `x` from a `v`.
- **Cost grows with the drawing.** Every stroke is re-drawn every frame, forever.

And there are two renderers, not one. The iPad's predictive ink is a hand-written duplicate inside
an HTML asset (`packages/aiui-paint/assets/ipad-client.html:504`) that draws raw `lineTo`
polylines at constant width, discarding the pressure it just captured. It is the canvas the person
holding the Pencil is actually looking at, and it is the lowest-fidelity renderer in the system.

None of this is fixable in place. A textured, pressure-and-tilt-driven, erasable instrument is a
**stamp engine**, and a stamp engine's natural substrate is pixels — which is exactly the substrate
that makes fading hard. That tension is the whole design problem, so it goes first.

## The hard part: ephemeral strokes on a pixel canvas

Once a stroke is stamped into a bitmap it has no identity. You cannot fade it, you cannot lift it,
and an eraser that ran over it has already destroyed the evidence. The naive fixes are both bad:
keep every stroke on its own layer (unbounded memory, unbounded per-frame compositing), or give up
the fade (not an option — the overlay's vanishing ink is a real feature that people rely on).

The resolution is to notice that **the fade window is finite**, and to let that one fact size
everything:

> A stroke is retained as an individual object until it falls past a horizon. Past the horizon it
> is flattened into a single bitmap and forgotten. The fade window, the undo depth, and the
> retention horizon are the same number.

That gives a surface with three tiers:

```
  display  =  settled  ∘  retained[0..n]  ∘  wet
             ─────────    ──────────────     ───
             one flat     bounded list of    the in-flight stroke,
             bitmap;      per-stroke tiles;  stamped incrementally
             no identity  each has vectors   into its own tile
                          AND a cached
                          raster
```

Every frame the display is an **ordered replay**: blit `settled`, then blit each retained stroke's
tile at its current fade alpha, then blit `wet`. Three properties fall out, and each one is a
feature we wanted:

**Erase is free, and it is undoable.** An eraser stroke is *just a stroke* with `tool: "erase"`,
blitted with `globalCompositeOperation = "destination-out"`. Because the replay is ordered, an
eraser at position *k* removes exactly what was drawn before it — `settled` and `retained[0..k-1]`
— and leaves later strokes alone. That is the correct semantics, and we get it without punching
holes in any stored layer, which means the eraser can itself be undone by popping it off the list.
A *partially faded* eraser partially erases, which is either a bug or the nicest thing in the
design; the Lab will tell us.

One qualification, learned by building it (see the plan's phase 3). "Just a stroke" is true of the
*compositing* and of the *geometry* — pressure and tilt still shape the eraser's dab, so you can
erase with a fine point or scrub with a laid-over edge — but it is **not** true of the density. An
eraser stamped at a pencil's `flow`, through a pencil's grain, produces a mask with tooth-shaped
holes in it, and therefore leaves behind, as speckle, precisely the ink it was asked to remove
(measured: a firm pass lifted 38%). The paper's tooth belongs to *laying* graphite and to nothing
else. This is where "one instrument" stops being the right abstraction, and it is the only place it
does.

**Undo is free below the horizon.** Pop the stroke. Above the horizon, an edit is permanent —
flattening is what makes it so. One concept, no snapshot ring, no memory cliff.

**Fade keeps its full curve.** Strokes inside the fade window keep their *vectors* (their dab
list), so a fading stroke can be **re-stamped** each frame under the warp style — hold → charge →
pop, including the width stretch and the heat toward white
(`packages/aiui-ink/src/fade.ts`, which is pure and survives the rewrite unchanged). Re-stamping is
affordable precisely because the set of fading strokes is bounded by definition: `fadeSec` seconds'
worth. Everything past the window is a cached tile blitted at alpha 1, or already in `settled`.

Two modes fall out of the same machinery rather than being special-cased:

- **`fadeSec > 0` (vanishing ink, the overlay's gesture mode):** strokes never reach `settled`.
  They are born, they live in `retained`, they warp, they pop, they are discarded. `settled` stays
  empty and the surface costs nothing over time. This is the overlay's ink, exactly as it behaves
  today.
- **`fadeSec === 0` (permanent ink, the Lab and the drawing case):** strokes age out of `retained`
  into `settled`. Steady-state cost is one blit plus the horizon.

Per-frame cost in either mode is `1 + n + 1` `drawImage` calls with `n` bounded by the horizon
(64 is generous), and tiles are **bounding-box sized**, not full-canvas — most strokes are small.
And the display only redraws when something is dirty: a new dab, a fade tick, an undo. A static
drawing draws nothing, which is a real battery and latency win on an iPad.

The one honest cost: a stroke that spans the whole page keeps a full-page tile until it flattens.
Bounded by the horizon, but worth measuring.

## The pencil: one instrument with range

The renderer is a **dab engine**. Resample the path at fixed arc-length spacing (≈0.1–0.25 × dab
radius) and stamp a textured sprite at each step. Everything expressive is a mapping from pen
telemetry to dab parameters:

| pen input | dab parameter | why |
| --- | --- | --- |
| pressure | radius, alpha | harder ⇒ broader and darker mark |
| altitude (tilt from vertical) | eccentricity, radius, alpha | tipping the pencil turns the round contact patch into an **ellipse** — the flat of the lead meets the paper. Low altitude ⇒ wide, elongated, lighter dabs: charcoal, and it *falls out of the geometry* rather than being a "charcoal mode" |
| azimuth | ellipse major axis | the direction the pencil leans is the direction the patch elongates |
| velocity | alpha (and radius, in sketch mode) | fast ⇒ less graphite laid down; also the **only** width signal available from a mouse or a finger |

That is the whole reason to have one pencil instead of ten brushes: the range is in your hand, not
in a menu.

**Grain is what makes it read as pencil, and it must be anchored to the paper, not to the stroke.**
The tooth belongs to the page; if it slides around with the stroke, the eye immediately knows it is
fake. So a stroke's tile is built in three steps: stamp the dabs into the tile (alpha accumulating
where they overlap — a pencil genuinely does darken on overlap, so this is correct rather than a
compromise); then set `globalCompositeOperation = "destination-in"` and fill the tile with a
repeating grain pattern **offset by the tile's origin in canvas space**, so the noise multiplies the
stroke's alpha exactly where the paper's tooth is; the result is graphite that catches on the peaks
and misses the valleys, and it stays put when you draw over it again.

Pressure then modulates *coverage*: light pressure and only the peaks take graphite, heavy pressure
and the valleys fill in. In v1 that is dab alpha against a constant tooth, which should be
convincing. If it is not, the escalation is per-dab grain thresholding (each dab sprite
pre-multiplied by the grain patch at its own canvas position, from a pre-tiled atlas) — more
expensive, more faithful. **This is a question the Lab exists to answer, and it should not be
answered in this document.**

## Point processing: modes are a parameter set, and there are fewer of them than you'd think

Four candidate modes present themselves — **gesture** (circle this chart), **writing** (prose),
**mathematical text** (precision matters), **sketching** (tilt, shading, form). They collapse.

Gesture, writing, and math all want the *same* thing: responsiveness over smoothness, and cusps
preserved. A circle drawn as a lasso and the letter `x` both fail in the same way if the filter
rounds their corners off, and neither is improved by the heavy streamlining a sketch wants. Their
differences are differences of *degree*, not of kind, and degree is what a parameter is for. So
there are **two presets**: `write` (gesture, prose, math) and `sketch`.

The mode is user-selected — a toggle, not an inference — and it is emphatically **not a second code
path**: it is a *parameter set* over one pipeline. One pencil, two presets.

**And we leave the door open to there being one.** The mode resolver is a *function of the stroke's
telemetry*, not a lookup in a table:

```ts
type PencilMode = "write" | "sketch" | "auto";   // "auto" reserved
resolveParams(mode: PencilMode, ctx: StrokeContext): PencilParams
```

For `write` and `sketch` the resolver ignores `ctx` and returns a constant — a preset is the
degenerate case of an adaptive mode. But the *shape* is already the adaptive one, so the day we
believe a stroke's own early telemetry (speed, extent, tilt, pressure) can tell writing from
sketching without being asked, `auto` becomes a real implementation behind an API nothing else has
to change. That is the placeholder, and it costs one indirection to leave standing. `auto` ships as
an alias for `write` until it earns more.

The pipeline, per sample, all of it causal (no lookahead — a filter that peeks ahead is a filter
that adds latency, and latency is the thing we are protecting):

1. **Low-pass the input** — a One-Euro filter, whose cutoff adapts to speed: aggressive smoothing
   when the pen is slow (killing jitter), light smoothing when it is fast (preserving intent).
2. **Detect corners** — turning angle accumulated over a short arc-length window. Past a threshold,
   mark a cusp.
3. **Interpolate** — centripetal Catmull-Rom (α = 0.5; the uniform variant overshoots and self-
   intersects on tight turns), **breaking the spline at cusps** rather than smoothing through them.
   This is the step that keeps a `k` from turning into a `l`.
4. **Resample to dab spacing** by arc length, interpolating pressure, altitude, and azimuth along
   the way.

And the presets:

| | **write** | **sketch** |
| --- | --- | --- |
| filter cutoff | high — responsiveness over smoothness | low — smooth over faithful |
| cusp threshold | tight; a corner is a corner | loose; a fast circle stays a circle, not a polygon |
| dab spacing | fine | coarser |
| width range | narrow; legibility | wide; tilt fully engaged |

The math is perhaps 150 lines and it is all pure. Which is why we write it ourselves rather than
reaching for SVG: SVG would give us path interpolation and nothing else — no grain, no pixel
eraser, no incremental stamping — and it would add a *third* renderer to a system whose central
problem is that it already has two.

## Latency

The iPad's stroke has to feel instant, and the round trip through the host is not. So the design
separates the two explicitly rather than hoping.

**Locally** (the Lab, and the iPad's own preview), the critical path is pointer → photons:

- Stamp from `getCoalescedEvents()` — the high-frequency samples between frames. Already done today
  on both ends; keep it.
- Stamp **incrementally**. This is the big one, and it is the payoff for going to pixels: each
  frame touches only the dabs for samples that arrived since the last frame, where today's renderer
  re-draws the entire drawing every frame. Pixels are *faster* here, not slower.
- **Predicted events** (`getPredictedEvents()`) stamped into a scratch overlay that is cleared every
  frame — never into the wet tile. Prediction that can't be rolled back is prediction you can't
  use; keeping it in a throwaway layer makes rollback a no-op. This is how PencilKit hides latency.
  **Measured, and it is off the table on the iPad:** Safari ships neither `getCoalescedEvents` nor
  `getPredictedEvents`, so this lever does not exist where we most want it. It stays in the design
  for Chrome, and the iPad's latency budget is met by the local preview and incremental stamping
  instead.
- `getContext("2d", { desynchronized: true })`, **if Safari honors it** — unverified, and now the
  most valuable remaining unknown for phase 3.

**Remotely**, the authoritative image is the video capture, and the local stroke is a promissory
note. Today the iPad retires that note on a **fixed 500ms timer** (`FADE_MS`,
`ipad-client.html:474`) — a guess, and wrong in both directions: if the host lags you get a hole
where your stroke was, and if it is quick you see the stroke twice, once in ink and once in pixels.

> **Superseded by [plan decision D3](./aiui-pencil-plan.md#decisions) (2026-07-14):** the preview
> retires on a **timed cross-fade from pen-up** (~500 ms, paint v1's shipped policy, optionally sized
> from WebRTC receiver stats), and the wire carries no frame metadata. The mechanism below was built,
> tested, and then deliberately deleted — the host renders strokes progressively, so a translucent
> stroke is double-rendered for the transit window *regardless* of any ack, and exact retirement
> bought too little for a vendor-dependent frame-identity dependency. Kept for the record:

The fix was to be an **ack**, one small protocol addition. The host, having applied a stroke
and captured a frame containing it, tells the client so; the client retires exactly those previews.
Video frames are opaque binary today with no metadata, so we add a sequence number to the frame and
a `strokesApplied { ids, frameSeq }` control message beside it. The preview then dies *because the
truth arrived*, which is the semantics we always wanted and never implemented.

## The package

One package, `@habemus-papadum/aiui-pencil`, with subpath exports — layered exactly as the
[playbook](../guide/frontend-playbook.md) prescribes, with the pure realm first and the DOM as far
out as it will go.

```
packages/aiui-pencil/
  src/
    ── layer 1: pure. no DOM, no solid-js, no import.meta.env. exhaustively unit-tested. ──
    geom.ts        vectors, arc length, resampling
    filter.ts      the One-Euro causal low-pass
    corners.ts     turning-angle cusp detection
    spline.ts      centripetal Catmull-Rom with cusp breaks
    dabs.ts        samples → dabs: the pressure/altitude/azimuth → radius/angle/alpha model
    pencil.ts      the instrument: parameters, and the write | sketch presets
    fade.ts        the warp curve — hold → charge → pop (salvaged verbatim from aiui-ink)
    protocol.ts    the wire types (isomorphic: node relay, desktop host, iPad client)

    ── the renderer: framework-free DOM. ──
    grain.ts       paper-tooth texture + the canvas-anchored pattern
    tile.ts        a bbox raster tile — stamp dabs, cache, re-stamp under a fade style
    surface.ts     PencilSurface — wet / retained / settled, the replay compositor, pointer capture

    ── remote pencil. ──
    host.ts        desktop host: applies remote strokes, owns screen capture, bridges the command bar
    sidecar.ts     the node relay, mountable on the channel's server (as paint's is today)
    client/        the iPad client — a real built app, NOT an HTML string

  lab/             Pencil Lab — the tuning app (see below)
```

Two structural points worth stating plainly, because they are the ones a reviewer should push on:

**The iPad client stops being a hand-written HTML asset.** It becomes a built app that imports the
same `PencilSurface` the host uses. This is the change that kills the duplicate renderer, and it is
the single biggest chunk of work in the migration. It is also non-negotiable: the whole premise of
"the local preview looks like the real thing" is that it *is* the real thing.

**`PencilSurface` replaces `InkSurface` for everyone**, including the overlay's gesture ink. The
overlay's ink is not a different tool — it is this tool with `fadeSec > 0`, a fixed brush, and
`minCommitPoints: 2`.

## Pencil Lab

An internal, never-published app (`--no-publish`; it is the package's own dev loop, the way
`aiui-paint/demo/` is today) whose only job is to let a human decide what the pencil should feel
like — by drawing with it, on an iPad, over the LAN. `channel.bind: "host"` already exists for
exactly this reachability (see [the trusted-LAN posture](../guide/warning.md)).

It is a real app, built to the playbook's four layers:

- **`model/store.ts`** — the durable roots and **the whole control surface**. Every brush parameter
  is a `control({ value, min, max, step, unit })` with a doc comment: dab spacing, grain scale and
  contrast, the pressure→radius and pressure→alpha curves, the altitude→eccentricity mapping, the
  One-Euro cutoffs, the cusp threshold, the fade seconds. The `PencilSurface` and its canvas are
  `durable(…)` — create-once, adopt-forever, so a hot edit to a control does not throw away your
  drawing.
- **`model/graph.ts`** — one `hotCellGraph` call. Derived cells: the resolved brush preset, the
  telemetry summary, the frame-time histogram.
- **`ui/`** — the canvas is a **durable imperative island**: it never reads a signal in its hot
  loop. Brush parameters cross inbound through `createEffect(source, handler)` pushing into
  `surface.setPencil(…)`; telemetry crosses outbound as one snapshot signal at ~4 Hz. This is the
  rule the frontend guide is most emphatic about and the one an ink loop is most tempted to break.
- **The agent surface** — `agentToolkit("pencil-lab")` + `registerStandardTools`. Which means
  **Claude can tune the pencil too**: read `report()`, `set` a parameter, look at the result. The
  Lab is a tuning rig for both of us, and that is not a gimmick — "make the grain finer and show
  me" is exactly the loop this repo exists to make possible.

And a **telemetry page**, which is genuinely the first thing to build and the first thing to look
at: a raw readout of what an Apple Pencil in Safari actually reports — `pressure`, `tiltX`/`tiltY`,
`altitudeAngle`/`azimuthAngle`, `twist`, coalesced-event counts, predicted-event counts, event
rate. **I have not verified Safari's support for `altitudeAngle`/`azimuthAngle` and cannot verify
it from this machine.** The entire tilt story depends on it. If iPadOS Safari only gives us
`tiltX`/`tiltY` we derive altitude and azimuth from those (they are equivalent up to a coordinate
change); if it gives us neither, the tilt half of this design is dead and we should find out on day
one, not in week three.

## Remote pencil: the protocol

The current protocol is a good starting point — normalized 0..1 coordinates, intent rather than
synthetic events, host owns the model — and it survives, extended in four directions.

**Richer points.** `{ u, v, p?, alt?, az?, tw?, t }` — position, pressure, altitude, azimuth,
twist, and **time**. Time is the notable addition: `NormPoint.time` exists in the current protocol
and is documented as "for later smoothing/velocity", and the iPad has never once set it
(`eventPoint`, `ipad-client.html:371`). Velocity-driven width is the only expressive signal
available from a finger or a mouse, so this is not optional.

**Tools and edits.** `strokeBegin` carries `tool: "draw" | "erase"`, the pencil preset, and the
brush parameters. A new `edit { op: "undo" | "redo" | "clear" }`.

**The ack.** A sequence number on each video frame, plus `strokesApplied { ids, frameSeq }` — the
signal that lets the iPad's preview die because the truth arrived rather than because a timer
expired.

**The command bus — and here is the pleasant surprise.** `barModel()`
(`packages/aiui-viz/src/modal/bar.ts`) already returns **pure, JSON-serializable data**: `BarRow[]`,
each a list of `CapView { command, payload, hold?, hint, lit, enabled }` or `WidgetView { control,
widget, label, enabled }`. Nobody designed it as a wire format, but the discipline that made it one
— *labels are stable, enablement is derived, the projection is a pure function of state* — means it
already is one. So the command bus is:

```
host → client   bar { rows: BarRow[] }            on every committed state change
client → host   command { name, payload? }        → engine.dispatch(name, payload)
client → host   control { name, value }           → the named control's setter
```

A remote dispatch is exactly as legitimate as a keypress, because the mode engine's commands are
the only writers and the reducer is pure — this is the property the engine was built for, arriving
somewhere it was never aimed. The iPad gets the app's real command bar, live-lit, with derived
enablement, for the cost of serializing a projection we already compute.

Two things to be careful about: **hold caps** (push-to-talk) need pointer down/up, not click — and
a disabled button swallows the release, which is a bug the intent client already paid for once; and
the paint protocol's existing `setArmed` (does the pen draw?) is *not* the mode engine's arm and
must not be conflated with it.

## Everything ink and paint do today, and where it lands

| capability | today | in `aiui-pencil` |
| --- | --- | --- |
| local pointer inking | `InkSurface` | `PencilSurface` — richer |
| remote stroke feed | `remoteBegin/Point/End/Cancel` | same, richer points |
| per-stroke color + width | `StrokeStyle` | pencil parameters + tool |
| vanishing ink, warp curve | `fade.ts` + per-frame re-stroke | `fade.ts` unchanged; re-stamp inside the retention window |
| `restartFade` (the ✒️→💨 flip) | rebase `bornAt` | same |
| document-anchored strokes | scroll offset at ingest + per-frame | same trick, applied at the tile origin |
| `minCommitPoints`, `shouldCapture` veto | options | options |
| `onAutoClear`, `strokeCount`, `inkBounds` | callbacks/queries | same |
| **`compositeInto`** | `shot.ts:231` | **deliberately dropped** — see below |
| relay, session list, sidecar | `aiui-paint` | `aiui-pencil/sidecar` |
| JPEG + WebRTC video, capture handshake | `host.ts` | unchanged in kind |
| `viewState`, scroll, pinch-zoom | protocol | unchanged |
| palm rejection, pencil-supersedes-finger | `ipad-client.html` | ported into the built client |
| — | — | **new:** eraser, undo, textured strokes, tilt, the command bus, the ack |

**`compositeInto` is dropped, and this is a fix rather than a regression.**
[Element Capture & the Capture Plane](./element-capture-and-the-capture-plane.md) already
established that its one real caller (`shot.ts:231`) is a **double-draw bug**: the capture already
contains the ink canvas, and `compositeInto` then draws the same ink a second time, at a different
scale, at `FULL` style while the on-screen ink may be mid-fade. The two sources disagree and the
model sees the disagreement. The correct mechanism — freeze the fade for the duration of the grab —
is described there. For the iPad path `compositeInto` was never needed at all: `getDisplayMedia`
captures the screen, ink canvas included.

## Landing it in the Chrome extension

The extension is the reason all of this has to be a superset rather than a fresh start, so the
migration is deliberately boring:

1. **The overlay's `Ink` adapter** (`packages/aiui-dev-overlay/src/multimodal/ink.ts`) is already a
   thin shim over `InkSurface` with exactly the surface the modality uses — `setActive`, `clear`,
   `hasInk`, `strokeCount`, `restartFade`, the four remote methods, `dispose`. Re-point it at
   `PencilSurface` with `fadeSec` from config, `minCommitPoints: 2`, and the shift-veto intact.
   `engine.strokeDone(count, bounds)` is unchanged — worth saying out loud that **the model never
   sees stroke geometry** today, only a count, a bounding box, and the pixels in the screenshot;
   this proposal does not change that, and if handwriting is ever meant to be *read* by the agent,
   that is a separate feature living upstream of the renderer.
2. **Delete `compositeInto` from `shot.ts`** and add the fade-freeze, per the capture-plane note.
3. **The intent client's ink claim** (`packages/aiui-intent-client/src/claims.ts`) currently relays
   `requestPage(tab, "ink", { on, fadeSec })`. It grows `tool` and the pencil preset — the same
   derived-claim shape, one more field. The eraser becomes a mode-engine region; undo becomes a
   command; both are then automatically keyboard-bound, bar-projected, agent-visible, and
   iPad-tappable, because that is what the mode engine does with anything expressed as a command.
4. **The panel's paint host** bridges `barModel(...)` to the iPad and `dispatch` back — the command
   bus, above.
5. `aiui-ink` and `aiui-paint` are deprecated on npm and their guide pages redirect. Neither has
   been reserved or trusted yet, so no published consumer exists to break. `aiui-pencil` needs
   `pnpm npm:reserve` + `pnpm npm:trust` before its first release (local, 2FA — CI cannot do it).

## Build order

The playbook's rule — one thin slice through all four layers early, then deepen — with the
riskiest unknown pulled to the very front:

1. **Telemetry first.** The Lab's raw-pen readout page, on the actual iPad. Answers the one
   question that can invalidate the design (does Safari give us altitude and azimuth?) before a
   line of brush math is written.
2. **Layer 1 whole:** `geom` → `filter` → `corners` → `spline` → `dabs` → `pencil`. Pure, unit
   tested, benchmarked. No canvas anywhere near it.
3. **`PencilSurface`:** the three tiers, the replay compositor, the eraser, undo. Verified in the
   Lab on a desktop with a mouse — which also proves the velocity-driven width path.
4. **The Lab proper:** controls, cells, the agent surface. Now tune, on the iPad, until it feels
   like a pencil. **This is the step that takes the longest and it is supposed to.**
5. **Remote pencil:** protocol, relay, host, built iPad client, the ack. Parity with today's paint
   stream, plus the eraser and undo.
6. **The command bus.**
7. **Cut the extension over**, delete `aiui-ink` and `aiui-paint`.

Steps 1–4 are the feature. Steps 5–7 are plumbing against a design that already exists.

## Open questions

- ~~**Safari's pen telemetry.** Unverified, and load-bearing.~~ **Answered on a real iPad
  (July 2026): pressure, altitude, and azimuth are all reported and all move. The tilt design
  lives.** Twist is absent (Pencil Pro only) and is read by nothing. Input arrives at 125 Hz —
  the display's full refresh — though `getCoalescedEvents`/`getPredictedEvents` are both absent in
  iPadOS Safari, which costs us the prediction lever for latency but no path fidelity. Details in
  the [plan](./aiui-pencil-plan.md).
- **Is per-stroke grain enough, or do we need per-dab grain thresholding?** Deferred to the Lab, on
  purpose. Do not decide this on paper.
- **A faded eraser partially un-erases.** Correct, or absurd? It follows from the model; the Lab
  will say whether it delights or confuses.
- **Does the overlay's gesture ink want texture at all?** Gesture is just `write` mode (above), so
  it needs no mode of its own — but a *textured* stroke may still be wrong for "circle this chart",
  which is a pointing act, not a drawing. Grain amount is already a parameter; the question is only
  what the overlay's default should be. Decide by looking.
- **The retention horizon's memory ceiling.** A full-page stroke keeps a full-page tile. Bounded,
  but measure it.
- **Should handwriting reach the model as geometry rather than pixels?** Out of scope here, but it
  is the question sitting behind "capture handwriting more accurately", and the answer changes what
  "accurate" means.
