# Pencil architecture review

Status: working review after the 2026-10-11 connectivity extraction. The existing
functionality is the starting point; the current component structure is **not**
an agreed destination. Compatibility with the retired remote API is not a goal.

## Scope and extraction record

The current repository keeps the instrument, local input behavior, Solid bridge,
Circle demo, and local tuning lab. The full pre-extraction packages were copied to
`../pdum-aiui-intent-tool-v0/extractions/2026-10-11-pencil-connectivity/` (relative to
the repository root), from commit `e2299a6ce97c96772e30b2ff4bff16d54df70356`.
That directory has per-file SHA-256 digests and is outside the staging workspace.
It does not overwrite the staging repository's older `aiui-util`.

Removed here: `aiui-remote-bar`, `aiui-room-relay`, `aiui-util`; pencil's protocol,
endpoint cores, host/client sessions, relay backend, sidecar, static client server,
iPad application, and lab hosting/capture UI. No future transport is introduced.
Live, Oracle, STT, browser automation, and credential infrastructure are unaffected.

The input behavior from the iPad application is **maintained here**, not left only
in that snapshot. It lives in `src/input/` and drives the surface's normal local
input. The snapshot also preserves the old video-coordinate and preview-handoff
integration if useful when designing future communication from scratch.

## High-level features to preserve

| Feature | Current implementation | Important behavior |
| --- | --- | --- |
| Rich pen samples | `telemetry.ts` | CSS coordinates, time, pressure, tilt/altitude/azimuth, twist, contact size; derive missing orientation pairs. Twist is recorded but does not drive the brush. |
| Sample conditioning | `filter.ts`, `corners.ts`, `spline.ts`, `geom.ts` | Causal One-Euro filtering, cusp detection, centripetal Catmull-Rom interpolation, arc-length sampling. |
| Expressive brush | `pencil.ts`, `dabs.ts` | Pressure/tilt/velocity change dab radius, opacity, and eccentricity; presets and tunable parameters. `auto` currently resolves to `write`, not an adaptive mode. |
| Textured raster ink | `stamp.ts`, `grain.ts`, `layer.ts` | Canvas-space grain, bounded stroke tiles, incremental stable-prefix stamping. |
| Erase and undo | `surface.ts` | Ordered erase strokes, undo within retention; erasers retain tool identity during replay. |
| Temporary ink | `fade.ts`, `surface.ts` | Hold/charge/pop, simple crossfade, animated clear, restarting fade, popping completed strokes without killing live ink. |
| Drawing data | `stroke-types.ts`, `surface.ts` | Raw samples for completed and live strokes; data remains available after older pixels flatten, until cleared/faded. |
| Programmatic input | `beginStroke`, `appendPoints`, `endStroke`, `cancelStroke` | Recorded/generated samples use the drawing pipeline directly; replay can suppress application callbacks. |
| Pen/finger arbitration | `input/pointer.ts` | Pencil supersedes finger ink; pen mode latches; large contacts never ink; mouse remains supported. |
| Navigation gestures | `input/pointer.ts` | Two fingers cancel provisional finger ink and emit pan/pinch; large finger contacts can still navigate; writing/cooldown suppress gestures. Applications own the view change. |
| Control-area palm guard | `input/controls.ts` | Blocks palm touches during writing and a cooldown; a refused touch remains refused through release and its trailing click. |
| Browser input details | `input/pointer.ts` | Coalesced samples, Safari stylus-touch opt-out, capture/veto/ignored controls, cancellation, blur, listener cleanup. Prediction availability is measured in the lab; predicted samples are not rendered. |
| Geometry changes | `surface.ts` | ResizeObserver, DPR-aware raster sizing, keep/rescale policies, translation and replay. |
| Solid consumption | `reactive.ts` | Immediate committed-state updates, throttled cumulative live snapshots, explicit subscription disposal. |
| Diagnostics | `lab/` | Device telemetry, raw/filtered/corner/dab overlays, parameter replay, draw/erase/undo/clear/fade. |
| Circle | `demos/circle` | Live circle/ellipse fitting, scores, frozen results after ink fades, guidance modes, gallery composition. |

## Current architecture

```text
Pointer events ── bindPenInput ──┐
                               v
Recorded/generated samples -> PencilSurface -> canvas
                               |      |
                        raw stroke    planStroke -> dabs -> stamp/grain/tiles
                        snapshots
                               |
                           inkSignals
                               |
                        Solid controls/cells -> components
```

1. **Pure model.** Samples, filtering, geometry, splines, brush parameters, dab
   planning, and fade curves can be understood and tested independently of DOM
   ownership. Grain generation also includes a DOM texture-building adapter.
2. **Input adapter.** `bindPenInput` owns pointer state and browser listeners. It
   emits drawing commands and optional navigation callbacks. Bounds are an
   injected rectangle; there is no video or network dependency. `guardPenControls`
   consumes the binding's activity and owns its own disposable listeners.
3. **Imperative surface.** `PencilSurface` still owns many responsibilities:
   canvas creation/adoption sizing, local input binding, stroke identity/history,
   rendering/cache allocation, fade time, subscriptions, and application callbacks.
   Input is a separate module, but the surface constructs it by default.
4. **Solid adapter and applications.** `inkSignals` binds any structural
   `InkSource`, not just the concrete surface. Apps own durable surfaces and signal
   adapters; disposable cells derive statistics or plans; components adopt canvases.
   The lab now has an explicit scope, PageBoundary, and guarded imperative bridges.

The raster structure is `settled bitmap + retained stroke tiles + live strokes`.
Retention bounds individually undoable tiles. **It does not bound all memory:**
flattened strokes retain raw sample data, and long live strokes retain every sample.
Fade time and undo retention are separate controls; the extraction corrects the
old comment that called them "the same horizon". Temporary ink is bounded by
age, not by a fixed stroke count or byte budget.

`planStroke` currently recalculates a stroke's plan as it grows. Incremental
stamping saves raster work but does not make the entire computation incremental.

## Changes made during extraction

- Input policies moved out of the remote client and into a public transport-free
  module; the surface uses that module instead of its simpler duplicate handler.
- `remoteBegin/Point/End/Cancel` became `beginStroke/appendPoints/endStroke/cancelStroke`.
  Batching preserves coalesced samples and emits one update for each batch.
- Start/end/cancel callbacks describe input operations without local/remote
  branches. `notify: false` supports silent replay; geometry rebuilds also stay
  silent. Subscribers still observe the drawing changes.
- Pointer cancel/capture loss/blur discard unfinished strokes; Circle resets a
  cancelled turn. Bindings and control guards have explicit cleanup.
- Remote lab code and its server plugin are gone. Brush tuning remains local.
- No barrel restructuring, document model rewrite, camera, or transport interface
  was introduced. Those require the review below.

## Proposed next architecture — for discussion

A useful candidate is **input → stroke document → renderer**, with the application
composing those parts and a small Solid adapter exposing their state. This is a
proposal, not a requirement that these become separate packages or classes.

| Proposed change | Why consider it | Decision still needed |
| --- | --- | --- |
| Separate stroke document from canvas rendering | Data ownership, editing, undo, persistence, and offscreen rendering should not depend on a DOM canvas. | Is the authoritative record samples, brush-resolved strokes, or both? Which edits and serialization features are actually required? |
| Make rendering a view over the document | Separate caches and GPU/Canvas resources from durable drawing state; permit multiple views. | Is one renderer enough, and should views share raster caches? |
| Keep one input policy with explicit coordinate mapping | Preserve the tested palm/gesture behavior across canvas, overlay, and future transformed views. | Should policy itself be a pure state machine emitting commands? How should zoomed/panned coordinates map to document space? |
| Give navigation its own viewport contract | Pan/pinch are currently only intents; `translate` mutates/rebakes data. | Do we want a camera transform, document translation, or both? What are zoom/resize semantics? |
| Distinguish new input, replay, and editing transactions | Silent replay is useful but a boolean is not a full operation model. | Which events should scoring, undo, selection, and subscribers see? Should replay emit one atomic document update? |
| Define retention and persistence independently | Undoable pixels are bounded; raw history is not. | What must survive flattening, fade, clear, route changes, and reload? Do we need a configurable data budget? |
| Preserve stable stroke identity during geometry changes | Current rebuild generates new IDs; it can reset ages and reconstruct earlier data. | Which operations change coordinates versus only the view, and which retain identity? |
| Audit scheduling and disposal | The surface schedules rAF continuously even while static, though most draws return early; Solid live throttles may outlive unsubscribe. | Demand-driven painting? Explicit activate/deactivate? Who cancels pending timers and owns each resource through HMR? |
| Split public import surfaces if useful | The root barrel includes the Solid adapter alongside pure math and imperative input. | Would `./core`, `./solid`, or another small split improve consumers without adding needless packaging? |
| Reduce lab-only duplicate input collection | `PenRecorder` observes the same raw events separately for telemetry; accepted ink and diagnostic live points can diverge after palm rejection. | Expose raw telemetry and accepted samples from one input adapter, while retaining the ability to inspect rejected contacts. |
| Measure planning before optimizing it | Long strokes are repeatedly filtered/interpolated although raster prefixes are cached. | Benchmark realistic 120 Hz recordings, then choose incremental planning, bounded tails, or workers only if necessary. |
| Make browser/device coverage explicit | Synthetic events cover policy; they cannot establish actual Safari/Pencil delivery quirks or perceived latency. | Maintain a small real-device checklist and recorded sample corpus alongside offline tests. |

## Suggested review order

1. Agree on the feature inventory and intended local use cases: scratchpad,
   temporary annotation, stroke measurement, and programmatic/replayed ink.
2. Decide stroke/document identity, history, and lifecycle semantics with pure
   tests before splitting the current surface.
3. Review input policy and coordinate mapping; preserve its existing behavioral
   tests while separating policy from browser event plumbing if that helps.
4. Decide the renderer/view boundary, scheduling, and resource ownership.
5. Revisit the Solid adapter and app composition: one source of truth, no
   per-sample reactive writes, correct HMR adoption and page deactivation.

New connectivity can later consume explicit samples, commands, or a rendered
stream. The local instrument should not decide pairing, signaling, transport,
authority between machines, or how an application synchronizes state.

## Verification boundaries

Unit tests pin the stroke math, fades, signal cadence, pointer arbitration,
navigation, coalescing, cancellation, disposal, and control guarding. Browser
checks exercise actual Canvas rendering and programmatic replay, erase/undo,
Circle drawing/fade/guidance/cancellation, gallery return, and lab parameter replay.
Actual Apple Pencil pressure, palm placement, Safari gesture delivery, and feel
still require an iPad; synthetic pointer tests are not that evidence.

Observed browser diagnostics: changing a lab parameter can emit Solid's
`EFFECT_RELAY_TEAR`: parameter state commits before the effect-driven replay
publishes the replacement strokes. This is the existing replay architecture,
not a lost input sample; the browser checks pass, but the mixed frame motivates
the document/transaction proposal above. PageBoundary/CellView also emit
`UNSTABLE_MEMO_OUTPUT` warnings. These remain review items, not suppressed logs.

Circle's standalone browser check exposed an unrelated optional audio-context
bug: `useAudioHub()` threw without a provider under Solid 2. An explicit null
default restores its documented undefined result. Circle's standalone root now
also uses PageBoundary. No audio routing or networking behavior changed.
