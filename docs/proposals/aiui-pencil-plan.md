# aiui-pencil: implementation plan

Status: **in progress** (July 2026). The design is [aiui-pencil](./aiui-pencil.md); this is the
phased plan and the running record of what is actually built — the same design/plan split the
[paint stream](../guide/paint-stream.md) used. Where the code diverges from the design, **this
document is the one that gets corrected**, and the divergence gets a note saying why.

## Ordering principle

The riskiest unknown goes first, and it is not a design question — it is a *fact about Safari*:
**does an Apple Pencil in iPadOS Safari report altitude and azimuth?** The tilt half of the pencil
(the charcoal broadening, the eccentric dab, the whole reason there is one instrument instead of
ten) rests on it, and nobody in this repo has verified it. Every phase after 1 is wasted if the
answer is no, so phase 1 is a *measurement*, on the real device, and it ships before any brush math
exists.

After that, the [playbook](../guide/frontend-playbook.md) order holds: pure functions, then cells
and controls, then components, then application — with a thin slice reaching the screen early so
the human steers by drawing rather than by reading.

## Use cases

Four, and they are one instrument with a choice of **plane** (D2) and a choice of **transport**:

| # | Use case | The plane | Input | Remote? |
| --- | --- | --- | --- | --- |
| 1 | **Mark up a live page** — gestural ("circle *this*") | overlay on the page | host mouse **and** iPad pencil | yes |
| 2 | **Write on the page** — text/math, still overlaid | overlay on the page | iPad pencil | yes |
| 3 | **A site that just lets you ink** | the page itself | local pen/mouse | no |
| 4 | **A scratchpad widget** — a component *in* a page | the component's box | host mouse and/or iPad pencil | optional |

1 and 2 are the `sketch`/`write` preset split — the same machinery. In 1–2 the AI's side-channel
screenshots **include the ink** (it is a descendant of the capture root; the capture-plane design).
3 is `PencilSurface` used directly — the Lab is this. 4 falls out of D2: a component's box is as
good a plane as a viewport, and a canvas plane streams via `captureStream()` with **no permission
grant**, which makes the scratchpad the easiest remote case, not an extra.

Cross-cutting: the widget exposes its state **reactively** (committed strokes *and* the stroke in
progress — see phase 4b) so sibling components can compute over the drawing; and the pipeline math
is reusable downstream with the widget's parameters or the consumer's own.

## Decisions

Standing decisions, with the date they were taken. A decision here outranks anything below it in
this document; if an older section disagrees, the older section is wrong and gets fixed.

### D1 · **The remote pencil is WebRTC-only.** (2026-07-14, Nehal)

No JPEG-over-websocket frame path, and no fallback to one. The view plane is a **`MediaStreamTrack`
over `RTCPeerConnection`**, full stop. `aiui-paint`'s JPEG relay is not the thing being ported; it is
the thing being replaced.

This is the user's call, and it is taken *before* the transport is written rather than after, so
there is exactly one frame path in the code and no dead branch pretending to be a safety net. The
consequences are real and are worked through here rather than discovered later:

- **Every plane is a track.** This is what makes the decision cheap: all three plane modes already
  produce a `MediaStreamTrack`, so one transport carries all of them —
  `canvas.captureStream()` (a canvas plane, **no permission at all**), `getDisplayMedia()` (a tab),
  and `getDisplayMedia()` + `restrictTo(element)` (a region). Element Capture composes with WebRTC
  by construction: `restrictTo` mutates the very track that the peer connection sends.
- The websocket keeps only what video cannot carry: `signal` (offer/answer/ICE, forwarded opaquely
  by the relay — the shape paint already proved) and `videoStatus` (why there is no picture).
- Frame identity looked like it had to be re-founded on `requestVideoFrameCallback` metadata — a
  vendor-dependent measurement waiting to happen. **D3 mooted it**: there is no frame correlation at
  all, so the one risky unknown in this decision was removed rather than resolved.

### D2 · **The capture target and the ink surface are the same rectangle** — the *pencil plane*.

Element Capture's measured behaviour ("frames become the target's box, not the viewport" —
[capture plane](./element-capture-and-the-capture-plane.md)) is what buys this: hold the invariant
and the iPad's normalized `u,v` of the *video* is, by construction, `u,v` of the *host's ink canvas*.
The wire then carries **no** coordinate metadata — no scroll offset, no zoom, no DPR, no viewport
size — and the three plane modes stop being three coordinate systems. A scroll moves what is
*underneath* the plane; it does not move the plane.

### D3 · **Preview retirement is a timed fade, not a frame correlation.** (2026-07-14, Nehal)

The iPad's local preview of a stroke cross-fades out over a fixed window — **500 ms from pen-up**,
paint v1's shipped constant — rather than being retired by identifying the exact video frame that
contains the host's copy. The wire carries **no frame metadata whatsoever**.

Why this is the right trade, spelled out because the alternative was half-built when the call was
made:

- **The host renders strokes progressively** — viewers watching the host (a human, a screen share,
  the model's screenshots) must see ink appear as it is drawn, so commit-on-pen-up was rejected
  outright. That means the preview and the video's copy of a translucent stroke overlap on the iPad
  for the transit window regardless of any ack; exact retirement would fix only the last ~200 ms of
  a problem that exists for the whole stroke.
- **The double-rendered translucent stroke during the window is acceptable.** Judged, not assumed:
  paint v1 ran precisely this policy (`FADE_MS = 500`, alpha ramp from `doneAt`, no ack of any kind
  — verified in `assets/ipad-client.html`) with an opaque, geometry-mismatched renderer, and the
  handoff was fine. Our copies at least agree about geometry.
- **Exact correlation needed the one thing in D1 that was unverified** — whether the WebRTC stack
  actually populates `captureTime` end-to-end. Dropping the requirement deletes the risk.
- **The window may be tuned, and may be made adaptive — that is the permitted scope.** The fade
  duration can be sized from the connection's *measured* delays (`RTCRtpReceiver.getStats()`: RTT,
  `jitterBufferDelay`, frame rate) instead of the constant; `fadeWindowMs()` in `remote.ts` does
  exactly this and nothing more. No per-frame work, no metadata negotiation, no second mechanism.

Supersedes the `frameSeq`/`inkAck` design that phase 5 was started with; the `FrameMeta`/`InkAck`
wire messages and the `PreviewLedger`/`BakeLedger` cores were deleted the same day, tests and all.

### D4 · **Viewport changes retire overlay ink; the scratchpad re-bakes.** (2026-07-14, Nehal)

When the host viewport scrolls, resizes, or zooms, **overlay ink retires via the animated clear**
rather than being transformed to follow. Transforming is only *correct* for pure scroll (a
translation) and pinch zoom (a rigid scale); browser zoom and resize **reflow** the page — content
moves non-uniformly and no transform of the ink can track it, so a circle would stay a circle while
the paragraph it circled changed shape. Retiring is honest, and doing it through the animated clear
(D5-adjacent feature, phase 4b) makes the disappearance read as intentional.

**The scratchpad is the exception**: its plane is a canvas, nothing reflows inside a canvas, and the
surface keeps raw samples and a replay path — so on resize its ink **re-bakes at the new scale**,
correctly. The mechanism lives in the widget; the app picks the policy.

### D5 · **The command bar is its own channel — a separate sidecar, socket, and package.** (2026-07-14, Nehal)

The bar is not a plane of the pencil protocol. It is the **mode engine, projected over its own
websocket**, mounted as its own channel sidecar at its own URL — so a remote client that is *just
the bar* (no pencil, no video) is a first-class thing, and any app with a mode engine gets a remote
control surface by mounting one sidecar. This is the launcher/channel sidecar pattern working as
designed (`Sidecar { name, mount(app, ctx) }`, one port, paths win by prefix — paint proved it).

Consequences:

- **A new internal package** (`--no-publish` at birth): protocol (`bar` down / `command` up, the
  `WireCap` ↔ `CapView` drift guard), the relay sidecar, the **host binding** (project a
  `solidModeEngine` over the socket, republish on every commit), and the **client component** (a
  Solid bar that renders rows and dispatches taps — the intent panel's shape, different sink).
- **The pencil protocol sheds the bar messages** (`BarState`, `RemoteCommand`, `WireCap` move out);
  it carries ink intent, scroll/zoom, WebRTC signaling, and `videoStatus` — nothing else. The pencil
  iPad app simply *also* connects to the bar socket and embeds the bar component.
- **Scroll and zoom stay pencil intents** (explicitly decided): they are continuous gestures against
  the plane, not commands through a reducer. Paint's proven shapes return
  (`scroll{du,dv}`, `zoom{center,scale}`).
- **Subset of commands**: the host binding takes an app-level filter over the projected rows. A
  per-cap `remote` tag on `CapSpec` is a possible `aiui-viz/modal` addition **only if the filter
  proves clumsy** — flagged for review, not done quietly.

## Phases

### Phase 0 — the package · **done**

`packages/aiui-pencil`, created `--no-publish`.

**That level is deliberate and temporary.** The package will eventually be `--public` (it replaces
two public packages), but publication levels are declared at birth and `--public` would auto-reserve
the name on npm — a live registry write, needing 2FA, from a branch whose design is not yet vetted.
So: `--no-publish` now; flip to `--public` (add `files`, add `publishConfig`, then
`pnpm npm:reserve aiui-pencil` + `pnpm npm:trust aiui-pencil` locally) when the design is accepted.
The flip is the documented path in CLAUDE.md, and it is mechanical.

### Phase 1 — telemetry: what does the pen actually give us? · **done**

Layer 1 (pure): `telemetry.ts` — normalize a `PointerEvent` into a `PenSample`, and reconcile the
two coordinate systems the spec offers for tilt, since browsers do not agree on which to provide:

- `tiltX`/`tiltY` — the classic pair (angles from vertical in the X-Z and Y-Z planes);
- `altitudeAngle`/`azimuthAngle` — the newer pair (elevation from the surface, compass bearing).

They are equivalent up to a coordinate change, so we take whatever a browser offers and derive the
rest. The conversion is real spherical trigonometry with genuine edge cases (the pen exactly
vertical, where azimuth is undefined; the pen flat on the page) — which is exactly why it is pure,
and unit-tested, and lives nowhere near a canvas. `PenCapabilities` records what was *reported*
versus what was *derived*, because a derived azimuth from a browser that only sends coarse integer
tilts is not the same instrument as a natively-reported one, and the Lab must not pretend otherwise.

Layer 2–4: the **Lab's telemetry page**. A live readout of pressure, altitude, azimuth, tilt,
twist, pointer type, contact geometry, coalesced- and predicted-event counts, and event rate — plus
a raw trace of the stroke with **no smoothing and no brush**, so the shape of the raw signal is
visible before anything is done to it. The point is to answer, on the iPad, in one sitting: *what
telemetry is real, how noisy is it, and how fast does it arrive?*

The panel reports a **verdict** (`native` · `derived` · `flat` · `absent` · `unknown`) built from
*observed ranges*, not from feature detection — because feature detection cannot answer the
question. A browser can carry an `altitudeAngle` property and hard-code it forever, and that is
indistinguishable from a user holding the pen upright until the user tilts it. `flat` is the verdict
that means "the field is there and it never moved", and it is the one that would kill the design.

### Phase 1 results — from a real iPad, with a real Apple Pencil

**The tilt design survives.** Pressure, altitude, and azimuth are all reported and all *move*. That
was the one finding that could have killed the design, and it didn't: the eccentric dab, the
charcoal broadening, and the argument for one instrument instead of ten are all still standing.

**Twist is absent, and it does not matter.** Only the Apple Pencil Pro has a barrel-roll sensor, and
nothing in `dabs.ts` reads `twist` — it is captured for completeness and used by nothing. No design
change.

**The first reported sample rate — 38 Hz — was a bug in the measurement, not a fact about the pen.**
`rateHz` was `samples ÷ (lastT − firstT)`, which divides by *the whole session, including every
second the pen was in the air*. Draw for a second, pause two, draw again, and a 120 Hz pen reports
~38 Hz. The number was wrong and completely plausible, which is the worst combination a measurement
can have — and the Lab exists precisely to catch that class of thing before a design gets built on
it.

The rate is now the **median interval between consecutive samples**, with gaps over
`IDLE_GAP_MS` (100 ms) discarded as "the pen was not down", plus a peak rate from the shortest
interval. Reproducing the pathological pattern (two 120 Hz bursts with 2 s pauses) now reads 105 Hz
median / 123 Hz peak, where the old formula gave 38.5 Hz — the user's exact number. A unit test pins
it.

**iPadOS Safari has no `getCoalescedEvents()` — and it does not matter.** Measured: **125 Hz**, API
absent. That combination is the whole story, and reading either half alone gets it wrong.

WebKit only implemented `getCoalescedEvents` in Safari Technology Preview 202 (August 2024), and MDN
still flags it as *not Baseline* — so its absence is the platform, not a fault in the probe. What it
costs us is the ability to reach *beneath* the browser's event rate to the Pencil's raw ~240 Hz. But
the event rate we are getting **is the display's full refresh** (125 Hz on ProMotion), which is the
ceiling for any drawing app on the web on this device. There is nothing beneath it left to recover.

The pipeline was designed for exactly this: the centripetal spline reconstructs the path *between*
samples, and dabs are placed by **distance, not by sample**, so a sparse fast stroke and a dense slow
one lay down identical graphite. 125 Hz feeds it comfortably.

> **A wording bug worth remembering.** The panel's first draft called this `SAMPLES LOST` — literally
> true and practically a lie, because it implies a recoverable signal we were failing to ask for.
> There isn't one. A measurement that is technically correct and *reads* as an alarm is a
> measurement that will send someone chasing a phantom, which is the same failure as the 38 Hz bug in
> a different costume. It now reports `125 Hz — the browser's ceiling`, and a test pins the
> distinction: no-API-at-full-rate is `good`, no-API-*and*-below-display-rate is `poor`.

### The one design consequence: latency has to come from somewhere else

If `getCoalescedEvents` is absent, `getPredictedEvents` almost certainly is too (it is even less
widely shipped). So **the predicted-events lever for hiding latency is off the table on the iPad**,
and phase 3's latency budget has to be met by:

- the **local preview** (already the core of the design — the iPad draws its own stroke immediately
  and retires it when the authoritative frame lands);
- **incremental stamping** — only the dabs for samples that arrived since the last frame, which the
  three-tier surface gives us for free and the old ink surface's full-redraw could never do;
- `desynchronized: true` on the 2-D context, **if Safari honors it** — still unverified, and now the
  most valuable remaining unknown for phase 3.

### Phase 2 — layer 1: the stroke pipeline · **done**

Pure, realm-free, exhaustively tested, no DOM anywhere near it:

- `geom.ts` — vectors, arc length, uniform resampling.
- `filter.ts` — the One-Euro causal low-pass (adaptive cutoff: smooth when slow, responsive when
  fast). Causal is the whole point; a filter that peeks ahead buys smoothness with latency, and
  latency is what we are protecting.
- `corners.ts` — turning-angle cusp detection over an arc-length window.
- `spline.ts` — centripetal Catmull-Rom (α = 0.5), **breaking at cusps** instead of smoothing
  through them.
- `pencil.ts` — `PencilParams`, the `write`/`sketch` presets, and `resolveParams(mode, ctx)` — the
  adaptive-shaped resolver that makes `auto` a future implementation rather than a future
  refactor (design doc, "modes are a parameter set").
- `dabs.ts` — the instrument: samples → dabs. Pressure → radius and alpha; altitude → eccentricity,
  radius, alpha; azimuth → the ellipse's major axis; velocity → alpha (and the *only* width signal a
  mouse or finger can offer).

### Phase 3 — `PencilSurface` · **done**

The three-tier surface from the design: `wet` / `retained` / `settled`, the ordered-replay
compositor, `destination-out` erasing, undo by popping, fade by re-stamping inside the retention
window. Framework-free DOM. Grain lands here too: the paper-anchored tooth (`destination-in`
against a canvas-space pattern), applied **once over accumulated alpha** — never per dab, never per
frame-batch — so that the wet stroke you are watching and the tile it becomes at pen-up are
literally the same pixels, and the commit has no pop.

Three things came out of driving it, and two of them were mine, not the design's.

**The eraser was a pencil that subtracted, and that is not an eraser.** The first erase pass over a
line lifted **38%** of it and left the rest as speckle. The surface was innocent: an eraser stroke
was being stamped exactly like a pencil stroke — alpha ≈ `flow` (~0.5), and then the paper's tooth
multiplied *into the mask*. A grained eraser mask has tooth-shaped holes in it, so it leaves behind,
as speckle, precisely the ink it was asked to remove. This is where the "one instrument" metaphor
stops: the eraser keeps the pencil's **geometry** (pressure and tilt still set the dab's radius and
its ellipse — erase with a fine point, or scrub with a laid-over edge) and must *not* keep its
**density**. Grain now applies to laying graphite and to nothing else (`grainOf`), which alone takes
a firm pass from 38% to 97.7%; a saturating `ERASE_BITE` closes the last stubborn 2% (a visible
ghost). At 1.6 a firm pass clears 99.9% *at any speed* — the dabs accumulate — while a feather-light
pass clears only ~73%, along a path its low pressure has already narrowed. So a light touch fades a
stroke rather than deleting it, which is worth being able to do.

**A stroke's tool is part of its identity, and the Lab had thrown it away.** Switching to the eraser
wiped the whole page. Not the surface — the Lab stored strokes as raw samples only, so the re-bake
that a parameter change triggers replayed every existing pencil stroke *with the currently selected
tool*. Strokes now carry their tool (`Recorded { tool, samples }`), the surface is the single place
a stroke is captured (it is the only thing that knows the tool), and the re-bake effect no longer
depends on `tool` at all. The general shape of this bug — a re-derivation that silently adopts
today's context for yesterday's data — is worth remembering; it is the third time this project has
hit it.

**Fade works, and the hold is free.** Measured on a 3 s stroke: ink mass is *identical* at 0.3 s and
1.6 s (the hold — and identical means the `"full"` tile is being reused rather than re-stamped,
which is what makes fading affordable); at 2.7 s the stroke thickens, heats, and *gains* mass while
still fully opaque (the charge — a width stretch no baked bitmap can do, which is the entire reason
retained strokes keep their dabs); by 3.0 s it is gone and discarded.

### Phase 4 — the Lab proper

Controls for every brush parameter, the cell graph, the agent surface
(`agentToolkit("pencil-lab")` — so Claude can tune the pencil too), the frame-time HUD. Then
**tune, on the iPad, until it feels like a pencil.** This is the longest phase and it is supposed
to be: it is the actual deliverable, and the four before it are scaffolding for it.

### Phase 4b — the widget grows its application surface · **done** (Lab-testable, no backend)

Everything here was pure widget + Lab work, verified in the browser the day it was written:

1. **Reactive stroke state.** The framework-free surface gains a `strokes()` snapshot (id, tool, raw
   points, born-at) and one `onStrokesChanged` callback (commit / undo / clear / fade-pop), **plus
   live progress**: the stroke in flight publishes its accumulated points as it grows, so a sibling
   cell can compute statistics *mid-stroke* (the user's requirement: throttle the events freely, but
   **never lose points** — which cumulative snapshots satisfy by construction: each emission carries
   every point so far, so coalescing drops emissions, never data). A thin Solid adapter
   (`reactive.ts`) turns both into signals — the live one through `aiui-viz`'s `throttled()`, its
   second consumer. The Lab replaces its hand-rolled stroke recording with the adapter and gains a
   demo consumer cell (live point count / stroke area, updating while the pen moves).
2. **Pipeline reuse.** A params accessor on the widget, plus a documented Lab example of running
   `planStroke` / `densify` / `detectCusps` downstream — with the widget's parameters or your own.
   (The math is already exported and pure; this is the accessor and the worked example.)
3. **Two clears.** `clear()` (exists) and `clearAnimated()` — every stroke enters the charge-and-pop
   phase of the existing fade curve immediately. Strokes flattened past the horizon have no dabs to
   warp, so `settled` alpha-fades as a layer while retained strokes pop; with fade active nothing
   ever reaches `settled`, so the overlay case always gets the full animation.
4. **Viewport policy (D4).** The retire-on-change and re-bake-on-resize mechanisms, policy chosen by
   the app.

**Verified, with numbers.** Statistics move mid-stroke: drawing a circle with synthetic pen events,
the panel read `17 pts · 2.2k px²` at sample 20 and `37 pts · 14.0k px²` at sample 40 — while the
pen was still down. At pen-up: `61 points, encloses 20.3k px²` against a true circle area of
20,106 px² (within 1%, shoelace over the densified path). An eraser pass showed up as
`2 strokes (1 eraser)`; undo brought the count back with zero Lab bookkeeping — the surface owns the
record now, and the Lab's hand-rolled `strokes` durableSignal is deleted. The animated clear
measured mid-flight: ink mass GREW 285k→373k alpha-sum (the charge) while heating (mean red 43→118),
then read exactly 0. The rescale is exact and round-trips: canvas to 59.8% width → ink to 59.9%;
restore the width and the ink returns to its original 242 px bounding box, points preserved
through both re-bakes.

### Phase 5 — remote pencil · *in progress*

Protocol v2, the relay sidecar, the desktop host, and the iPad client **as a Solid app that imports
the same `PencilSurface`** — which is what finally kills the duplicate renderer. Everything above the
library is a playbook app: `store` / `graph` / `ui`, controls and cells, an agent surface. The
framework-free tier is the library and the wire, and nothing else.

**Two sockets, because the bar is its own channel (D5).** The pencil socket carries ink and the view
plane's plumbing; the bar socket (phase 6's package) carries the mode engine's projection. The iPad
app connects to both; a bar-only remote connects to one.

| Plane | Direction | Carries |
| --- | --- | --- |
| **ink** | iPad → host | `strokeBegin` / `strokePoints` / `strokeEnd` / `strokeCancel` — rich points (`u,v` normalized, plus `t`, pressure, altitude, azimuth), the `tool`, and the `mode`; plus `scroll{du,dv}` / `zoom{center,scale}` (D5) |
| **view** | host → iPad | a `MediaStreamTrack` over `RTCPeerConnection` (**D1** — never JPEG); the websocket carries only `signal` and `videoStatus` |

**Preview retirement is a fade (D3).** The iPad draws a local preview so the pen feels immediate,
streams the same stroke to the host, and watches it come back inside the video. From pen-up the
preview cross-fades out over `fadeWindowMs()` — 500 ms by default, paint v1's proven constant, or
sized from the receiver's measured RTT + jitter-buffer delay when stats are available. No frame
correlation, no per-frame metadata, no ack (D3 has the full reasoning).

Sub-steps, in playbook order — the plane that needs **no permission grant** comes first, so every
layer is proven before the one human-gated step:

1. `protocol.ts` / `remote.ts` — **done** (bar messages to be moved out per D5; scroll/zoom to be
   restored).
2. **C1 — the relays** · **done**: the pencil backend (`/pencil`: rooms, ink + peer-addressed
   signaling + `videoStatus` with join replay — *no media*; video is peer-to-peer) as the two
   host-neutral seams the bar package proved, mounted by the channel sidecar AND by the Lab's own
   Vite plugin — the same code path, which is the honest proof the seam is host-neutral. Registered
   always-on in the launcher next to paint and bar. Six relay tests over real websockets.
3. **C2 — host mode in the Lab** · **done**: `pnpm lab` is the whole rig. The Lab auto-registers as
   a host (`LabHost`: one shared `captureStream(30)` track, one `RTCPeerConnection` per viewer);
   `/client.html` is the viewer — session picker, WebRTC video, a real `PencilSurface` preview
   (`localInput: false`, `fadeSec` = the D3 window), one pointer path feeding two sinks, and the
   pencil plane (D2) as a live div congruent to the displayed picture. **Measured end-to-end: a
   diagonal drawn at plane fractions 0.25→0.75 landed on the host at 0.246→0.750 on both axes.**

   Three real findings from driving it, all now fixed and all of which would have bitten the iPad:

   - **The plane must track the video's own resize events, from the video's own ref.** WebRTC ramps
     resolution from a tiny first frame; attach the listener anywhere racy (the stage's ref) and the
     plane silently stays at its full-stage default — strokes land y-compressed by exactly the
     letterbox ratio (measured 0.295→0.704 for a sent 0.25→0.75; x untouched, which is what made it
     look like anything but a coordinate frame bug).
   - **A still canvas emits no frames**, so a viewer joining a quiet host waits forever on a stream
     that has never produced one. `PencilSurface.repaint()` exists for this single consumer, and the
     host ticks it at 2 Hz **only while viewers are connected**.
   - **Video has no alpha.** The surface's canvas is transparent (the "paper" was CSS behind it), so
     the capture streamed ink-on-black. The `background` option paints opaque paper
     `destination-over` after the replay — erased areas read as paper, not holes, and the overlay
     use case (which requires transparency) is untouched by default.

   One rig-only caveat, worth remembering: Chrome pauses rAF in hidden tabs, so a host TAB
   backgrounded by selecting the client tab stops producing frames. The rig uses a separate host
   window; the real deployments (Lab visible on the Mac, iPad as the viewer) never hit it.

   **Second pass, from the user's real-iPad test (2026-07-14).** Three fixes, all verified in the
   browser:

   - **The preview drifted vertically, worse toward the bottom** — the surface's resize trigger
     checked WIDTH only, so a container that changed height alone (the plane, shrinking when the
     letterbox arrives) left a tall backing store squeezed by CSS: preview y scaled by
     displayHeight/backingHeight, dead-on at the top, off by dozens of px at the bottom. Now both
     axes trigger. Verified: backing ≡ plane, and a stroke drawn at plane-y 0.9 renders its preview
     centered at exactly 0.900.
   - **Pencil mode (the old paint client's rules, ported)**: the first pen event latches it — from
     then on only the pencil inks; palms (contact > 60 px) never ink; no touch interrupts a drawing
     pencil; two fingers always navigate (pinch → `zoom`, drift → `scroll`); one finger inks only
     before any pen; a mouse always inks. All six rules pinned by synthetic-pointer verification,
     plus a visible «✍️ pencil» chip when the latch engages.
   - **The `share` plane: `canvas` | `tab` (use case (b), pulled forward from C4).** Tab mode lands
     remote strokes on a transparent viewport OVERLAY over the whole Lab page (no `background`, no
     local input) and serves video from `getDisplayMedia({ preferCurrentTab })` — click-gated, so
     the host reports `needsGesture`/`denied` and every client explains itself instead of showing
     black. Incoming `scroll` moves the real window AND retires the overlay ink via the animated
     clear (D4). Verified end to end minus the grant itself (agent Chrome cannot grant capture):
     remote pen stroke → overlay (1,700 px, paper untouched); remote two-finger pan → `scrollY`
     140→56 and overlay ink 1,700→0 through the D4 clear. The grant click is the user's rung.
     Plane switches re-offer to every connected viewer; a viewer whose plane vanished un-hides its
     status note instead of freezing on the last frame.

   **Third pass, same day.** Two more from the user's hands:

   - **Tab-mode preview offset (parallel double strokes).** Client-side frame-differencing pinned
     it to a number: a stroke sent at u = 0.45 appeared in the video at 0.4436 — exactly
     0.45 × 1035/1050. The mechanism: a fixed element's `100%` width EXCLUDES classic layout
     scrollbars (15 px in Chrome for Testing), while the tab capture INCLUDES them, so the overlay's
     frame was a sliver smaller than the captured frame and every stroke compressed by the ratio —
     per axis, per scrollbar. The overlay is now sized `100vw/100vh` (spans the scrollbar strips),
     making the overlay frame ≡ the captured frame; re-measured error: −8.9 px → +4.6 px (noise).
     Measurement notes for next time: frame-differencing against the whole tab is polluted by the
     sidebar's own changing text (stroke counters!) — localize the diff around the expected
     position; and the first measurement of anything WebRTC should distrust dimensions taken while
     the encoder is still ramping resolution.

   - **The preview popped instead of fading.** The warp curve (hold → charge → pop) is a stroke
     *announcing its death* — right for gestures, wrong for a handoff. New `crossfadeStyle` +
     `fadeCurve: "crossfade"` option: a smoothstepped dissolve, width and glow held at identity —
     which keeps `isFullStyle` true, so the fading tile is reused as-is and the fade costs nothing.
     Measured: 1.00 → 0.82 → 0.49 → 0.21 → 0.02 → 0 across the window.
   - **"cannot read properties of undefined (reading getDisplayMedia)"** on the user's first tab
     try — not permissions: **secure context**. `navigator.mediaDevices` does not exist on a LAN-IP
     http origin; localhost is the exemption. The host page must be opened via localhost (or https);
     only remote clients use the LAN URL. `shareTab()` now names this fix in its `denied` detail,
     and the Remote panel warns proactively before the button is even shown. With that corrected,
     the **full tab loop was driven agent-side, end to end**: the session browser launches with
     `--auto-accept-this-tab-capture`, and a real CDP click carries user activation — capture went
     live with no picker, the client received the whole 1870×1346 tab as video, and an ellipse drawn
     from the client landed on the viewport overlay within a stroke-width of its target (measured
     center 555,336 vs expected 561,337 at dpr 1.25). C4's remaining novelty is only the
     intent-client integration + `restrictTo`.
   - **The tab-mode overlay froze the entire host page.** `setActive(true)` — called out of habit on
     the `localInput: false` overlay — set `pointer-events: auto` on a full-viewport z-2000 canvas
     with no listeners: pure blocking. `setActive` is now a no-op for inputless surfaces (they never
     own the pointer). Two adjacent traps fixed with it: the constructor's INLINE styles beat any
     stylesheet (the `.overlay-canvas { pointer-events: none }` rule was silently losing), and its
     `position: absolute` would have scrolled the viewport plane away with the page — the overlay is
     now inline-styled `fixed`. **Verification lesson, recorded:** all prior driving used
     `dispatchEvent`, which bypasses hit-testing entirely — a full-page pointer blocker was
     invisible to it. Interactivity claims need real-input verification (`elementFromPoint`, CDP
     input), not synthetic dispatch.
4. **C3 — the client as a deliverable** · **done**: the WebRTC/session glue extracted into the
   library (`HostSession` / `ClientSession` — an integrator never touches an `RTCPeerConnection`;
   the Lab and the client page are their reference consumers), the client BUILT
   (`pnpm build:client` → `assets/client/`) and SERVED by the sidecar at `GET /pencil/` (paint's
   iPad exception: an iPad has no frontend process), the bar component wired in (auto-joins; the
   Lab projects its real actions over `/bar` through a hand-rolled structural `BarSource` —
   verified round trip: a remote tap on `tool.erase` flipped the host's actual control and the lit
   state came back), a write/sketch selector, and the adaptive D3 fade window fed from
   `ClientSession.stats()`. `aiui pencil url` mirrors `aiui paint url`. The **sidecar seam test**
   (`src/sidecar.test.ts`) mounts pencil + bar on a plain Express server exactly as the channel
   does and drives real websockets through it — the requested "test the sidecar integration
   without modifying anything in the overlay", as a permanent regression test.
5. **C4 — the overlay host** · **handed off**: intent client + `getDisplayMedia` + `restrictTo`
   (the capture plane). Deliberately NOT done here — the
   [handoff document](./aiui-pencil-handoff.md) is the deliverable instead: the five swaps
   (surface, host, client, sidecar, arming→bar), the wire mapping, the D2 overlay contract, and a
   WebRTC triage section. The honest complexity verdict is recorded there: small, because the
   sessions live in the library.

Use cases 3–4 are alive now; use cases 1–2 activate at the integrator's C4.

### Phase 6 — the bar channel (own package, D5) · **done**

`packages/aiui-remote-bar` (`--no-publish`), built by a parallel agent and reviewed: the bar/command
protocol (the `WireCap` ↔ `CapView` drift guard is *enforced* — its tsconfig deliberately typechecks
test files, unlike this package's), the endpoint cores, the `/bar` relay sidecar (mounted always-on
by the launcher next to paint; `--aiui-no-sidecar bar` opts out), the host binding (a structural
`BarSource` — **zero `aiui-viz` changes needed** — republishing on every engine commit, with the
app-level row filter for the remote subset), and the `RemoteBar` Solid component + ws client.
38 tests. One good divergence from paint, recorded in its README: the bar is event-driven where
video is continuous, so the relay caches each host's last `bar` and replays it on join — otherwise
a remote joining a quiet host would stare at a blank bar until the next dispatch. `CapView.reveals`
(mode-scoped sub-widgets) is deliberately not on the wire; flagged for later if a remote wants it.

### Phase 7 — cut the extension over

Re-point the overlay's `Ink` adapter at `PencilSurface`, delete `compositeInto` from `shot.ts` (a
double-draw bug, per the [capture-plane note](./element-capture-and-the-capture-plane.md)), grow the
intent client's ink claim with `tool`/preset, then delete `aiui-ink` and `aiui-paint`.

## Additions to `aiui-viz` — **landed**, and what changed on the way

`aiui-viz` is young, and the guidance is to grow it rather than work around it. Two things landed;
one proposal was withdrawn when the evidence contradicted it, and one turned out to be already done.
Both of the survivors were shaped by asking *what is the general operation here?* — and in both
cases the answer was smaller than the thing originally proposed.

### 1. `adopt()` — and `durableCanvas()` on top of it · **landed**

The proposal was `durableCanvas`. Building it showed that the canvas is the *least* general part,
and the real primitive is one level down.

**The footgun, first.** Every component that shows a durable resource performs the same ritual, and
the obvious spelling of it is silently wrong:

```tsx
<div ref={(host) => { pad.mount(host); onCleanup(() => pad.unmount(host)); }} />
```

A ref callback runs **outside any reactive owner**, so that `onCleanup` is dropped on the floor —
`[NO_OWNER_CLEANUP]`, a console line that is easy to lose among Vite's chatter, and no other symptom.
The listeners then survive every hot swap and stack up. In the Lab this showed up as a single stroke
committing itself half a dozen times after an afternoon of edits, which looks nothing like its cause.

The second hazard is the reverse: on a hot swap Solid mounts the successor **before** disposing the
predecessor, so an unconditional `canvas.remove()` in cleanup reaches over and rips the canvas out of
the *new* component's DOM. Both `SimCanvas` and `AztecCanvas` already carried a hand-written comment
about this, and a manual `myHost` guard — and aztec's docblock says outright that it "copies
morphogen's SimCanvas discipline". A hazard comment propagating by copy-paste is the signal to
extract.

```ts
adopt(setup: (host: HTMLElement) => (() => void) | void): (host: HTMLElement) => void
```

Called **in the component body** (`ref={adopt(…)}` is exactly that — a JSX expression evaluates while
the component runs, so the owner is present), it registers the cleanup where cleanup can actually be
registered, and returns the ref callback. With no owner it says so loudly instead of leaking in
silence. That is the general operation, and it has nothing to do with canvases: the Lab's two
islands — `PencilSurface` and the diagnostic pad — **create their own canvas and must keep doing so**,
because they are framework-free and the same surface has to run on a plain iPad page with no Solid
anywhere near it.

`durableCanvas(key, init?)` then costs about ten lines on top: the create-once element plus an
`adopt()` with the "still mine?" guard baked in. It earns its place on evidence — morphogen's
`simCanvas` and aztec's `aztecCanvas` are literally `durable(key, () => createElement("canvas"))` —
and **both are migrated to it**, deleting both copies of the hazard comment. Verified by running
them: the Turing pattern still cooks on its adopted WebGL context, the tiling still paints.

### 2. `throttled(box, hz)` — a write policy, not a kind of signal · **landed**

The proposal was `sampledSignal(hz, initial)`. Asking what the general operation is made it *smaller*
and killed the new concept.

"Publish a snapshot at ~4 Hz" is not a kind of signal — it is a **write policy on a signal you
already have**. So it wraps a `SignalBox` rather than inventing a parallel one, and durability and
rate-limiting stay orthogonal and compose:

```ts
export const telemetry = throttled(durableSignal("telemetry", empty), 4);
```

The semantics are a throttle **with a trailing edge**, and the trailing edge is the whole point: the
first write lands at once (the UI reacts immediately), writes inside the window coalesce with
latest-wins, and **the last value always lands** — even if the island then goes quiet forever. A
naive "publish every 250 ms if something changed" timer costs the same and drops the final sample of
every stroke, which is precisely the sample being watched for.

The Lab's recorder consequently **lost its `setInterval` entirely**: it now offers a snapshot on
every sample (120+/s) and the boundary decides what becomes a commit. The cadence policy left the
island, which is where it never belonged — every rAF loop in the repo currently re-invents that timer
slightly differently.

### 3. The `ControlToggle` a11y fix — **withdrawn: I was wrong**

`ControlToggle` already sets `name` on its checkbox. Verified live rather than from memory: 25 form
fields on the Lab page, **zero** missing both `name` and `id`. Whatever I saw, it was not this. No
change made.

### 4. *Not* proposed, and I want to be explicit about it

The **One-Euro filter** is generic signal processing and could plausibly live in `aiui-viz`. I am
deliberately keeping it in `aiui-pencil`: it is pure, it is exported, and if a second consumer ever
wants it, *that* is the moment to move it. Speculatively hoisting it into the framework is the exact
failure mode the library's own guidance warns against.

The same logic applies to the raw `throttle(fn, hz)` hiding inside `throttled` — the remote pencil
(phase 5) may well want it for the wire. It stays private until it does.

## What is verified, and how

- `pnpm -C packages/aiui-pencil test` — **130 tests**, covering every layer-1 module, the wire (framing, the CapView↔WireCap drift guard, coordinate round-trips through disagreeing surfaces), and both endpoint cores driven with no socket (progressive rendering, host-side brush resolution, signaling passthrough, the fade window's clamps). The load-bearing
  ones assert *properties*, not outputs: dabs are spaced by arc length so a fast stroke is not dotted;
  a marked corner comes out of the spline sharp while the same five points unmarked bow 0.72px past
  the elbow; a tilt-less pen draws exactly as an upright one (the no-branch degradation); One-Euro
  with a higher `beta` tracks a fast ramp more closely than one with a lower `beta`.
- `pnpm -C packages/aiui-pencil typecheck` — the library and all 10 Lab files.
- `pnpm biome check packages/aiui-pencil` — clean.
- **The Lab was actually driven**, not just typechecked: a synthetic pen stroke (an `L`, with rising
  pressure and tilt) through the real event path put 3,584 pixels on the canvas, put the cusp ring
  exactly on the elbow, and produced a mark that visibly broadens as pressure and tilt rise. Every
  knob in that run was turned through the **agent tool surface** (`window.__pencil-lab`'s `set`), not
  by hand — which is the tuning loop the design claims, exercised.

`PencilSurface` has **no unit tests, deliberately**: it is a canvas compositor, and every claim worth
making about it is a claim about pixels. So it is verified by driving the Lab in a real browser and
reading the framebuffer back — which is a stronger test than a mocked 2-D context would be, and is
the only kind that could have caught the grained eraser. The three properties, and the numbers they
produced:

| Claim | How it was measured | Result |
| --- | --- | --- |
| An eraser removes **only its own path** | ink mass inside the eraser's band vs. the paper it never crossed | 99.9% cleared inside; **exactly 0** disturbed outside |
| **Undo brings erased ink back** — the striking consequence of an *ordered replay*, since nothing was ever punched out of a stored layer | erase, then undo, then re-measure | restored to the identical byte count |
| Fade **warps**, then pops | mass, row count, and colour, sampled across a 3 s stroke's life | unchanged through the hold; thicker + hotter + heavier while charging; zero, and discarded, at the deadline |

The one measurement that is *not* yet real is latency. It cannot be: a synthetic `pointermove`
dispatched from a script has none of the input-to-photon path that matters. Phase 4's tuning happens
on the iPad, by hand, and that is where the incremental-stamping claim gets tested.
