# @habemus-papadum/aiui-pencil

A pressure/tilt-driven pencil: textured raster strokes, erasing, undo, vanishing
ink, local pointer policies, programmatic input, and a Solid signal adapter.

```sh
npm install @habemus-papadum/aiui-pencil
```

Everything is exported from the package root:

| Component | Responsibility |
| --- | --- |
| `penSample`, `planStroke`, presets and geometry | Normalize input; filter, preserve corners, interpolate, and produce pressure/tilt/velocity-sensitive dabs. |
| `PencilSurface` | Own a canvas, render strokes, retain undoable raster tiles, flatten older ink, erase, fade, resize, and translate. |
| `bindPenInput` | Pencil priority, palm rejection, finger/mouse drawing, coalesced samples, two-finger pan/pinch callbacks, and pointer lifecycle. Used by the surface's default local input. |
| `guardPenControls`, `penWriting` | Protect surrounding controls from palm touches during writing and briefly after pen-up. |
| `inkSignals` | Expose committed and live stroke data to Solid. Live updates are throttled cumulative snapshots; no samples are dropped. |

## Use a surface

```ts
import { PencilSurface, WRITE, inkSignals } from "@habemus-papadum/aiui-pencil";

const paper = new PencilSurface({ target: container, params: () => WRITE });
paper.setActive(true);
const ink = inkSignals(paper);
// ink.strokes() / ink.live() are Solid accessors.
// On final disposal: ink.dispose(); paper.dispose().
```

The container needs a positioned, nonzero box. `setActive` controls whether the
canvas intercepts local pointers; `localInput: false` creates a surface driven
entirely by application code. A surface owns its DOM and must be disposed by its
application owner, not by each component that temporarily adopts its canvas.

## Feed recorded or generated samples

```ts
paper.beginStroke("stroke-1", { tool: "draw", params: WRITE, point: samples[0] });
paper.appendPoints("stroke-1", samples.slice(1));
paper.endStroke("stroke-1");
// Or discard an unfinished mark: paper.cancelStroke("stroke-1").
```

Samples use canvas CSS pixels and carry pressure, orientation, and time. IDs must
be unique among active strokes. Start/end/cancel callbacks apply to programmatic
input too. Pass `notify: false` to `beginStroke` for replay: pixels and drawing
subscriptions update, but application stroke callbacks do not fire. Internal
resize/translation rebuilds also suppress these callbacks.

## Input and navigation

The first pen contact latches pen mode for that binding's lifetime: fingers then
stop drawing. A pencil cancels an in-progress finger stroke; palm-sized contacts
never draw. Two fingers pan/pinch even when their reported contact size is large,
except while writing or during the 500 ms post-pen cooldown. A second finger
cancels the first finger's provisional mark. Pointer cancellation, capture loss,
blur, and disposal discard unfinished ink.

`onPan(du, dv)` and `onZoom(centerU, centerV, scale)` on `PencilSurface` report
navigation gestures. Pan and centre coordinates are fractions of the canvas;
scale is incremental. **The application decides how to change its view.** The
surface does not scroll a page or implement a camera automatically.

For custom input ownership use `bindPenInput(element, { sink, bounds?, onPan?,
onZoom?, ... })`. It has no dependency on a renderer, video, transport, or Solid.
Give a custom input element `touch-action: none` so the browser does not take
over its drawing/navigation gestures. The returned binding exposes
activity/counters, `cancel()`, and `dispose()`.
`data-pencil-input-ignore` excludes controls nested inside the input element.

`guardPenControls(controls, () => paper.input)` returns a cleanup function. The lab
uses it around its controls; it keeps a refused touch blocked through release.

## Demos and checks

```sh
pnpm -C demos/circle dev                  # circle scoring, fade, guidance modes
pnpm -C packages/aiui-pencil lab          # local brush tuning and telemetry
LAB_INTERFACE=en0 pnpm -C packages/aiui-pencil lab # skip the network picker
pnpm -C packages/aiui-pencil test
pnpm -C packages/aiui-pencil test:browser
```

The lab listens on all network interfaces by default. At startup, choose the
number of the interface on the same network as your iPad (usually `en0` on a Mac).
Copy the printed **iPad** URL and paste it into Safari with Universal Clipboard.
The picker lists external IPv4 addresses, avoiding the many IPv6 addresses on a
Mac. `LAB_INTERFACE` accepts an interface name or an exact IPv4 address. With one
address, or without an interactive terminal, the first address is selected
automatically, preferring Ethernet/Wi-Fi interfaces. The URL uses Vite's actual
port, including when its default port is occupied. `--host 127.0.0.1` keeps a run
local and skips the picker.

The lab retains raw/filtered/corner/dab diagnostics and replays existing strokes
when brush parameters change. Circle remains a gallery demo. Neither needs a
pairing service or remote host.

The former remote application, WebRTC sessions, protocol, backend, and sidecar
were extracted to `../pdum-aiui-intent-tool-v0/extractions/2026-10-11-pencil-connectivity/`
(relative to the repository root). `./client`, `./server`, and `./sidecar` are
removed. Other packages' networking is unchanged.

[Getting started](./docs/getting-started.md) ·
[Architecture and refactoring review](./docs/architecture-review.md)
