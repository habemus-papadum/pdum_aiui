# @habemus-papadum/aiui-pencil

Editable stroke input, independent geometry processing, Canvas views, fading,
and Solid observation. Ink can select, annotate, or author content; the library
requires no classification of the user's intent.

```ts
import { PencilSurface, WRITE, inkSignals } from "@habemus-papadum/aiui-pencil";

const paper = new PencilSurface({ target: container, params: () => WRITE });
paper.setActive(true);
const ink = inkSignals(paper.document);
// ink.strokes(), ink.live(), ink.snapshot()

// Dispose owners when finished; unmounting a view can simply park it.
ink.dispose();
paper.dispose();
```

The container needs a positioned, nonzero box. `setActive(false)` cancels owned
pointer input and parks rendering. The document survives disposal of its views.

| Import | Contents |
| --- | --- |
| Package root | Convenient combined API |
| `./core` | Framework-free document, sessions, samples, geometry, and brush planning |
| `./input` | Browser binding, pure contact policy, and surrounding control guards |
| `./canvas` | Canvas views, presentation effects, attachments, and `PencilSurface` |
| `./solid` | `inkSignals`: consistent snapshots with throttled live observation |

## Data, editing, and captures

```ts
import { createInkDocument, createInkSession, WRITE } from "@habemus-papadum/aiui-pencil/core";

const document = createInkDocument({ historyLimit: 64 });
const input = createInkSession(document, { params: WRITE });
input.begin("pen", samples[0]);
input.append("pen", samples.slice(1));
input.finish("pen");

const capture = document.capture();
// Submit this frozen evidence with the application's speech and context.
// After applying a result, remove only captured records still at their revisions:
document.retire(capture);
document.undo();
input.dispose();
```

Completed strokes retain stable IDs, immutable samples, their own brush profile,
placement, and partial-erasure masks. `document.setParams(ids, params)` reprocesses
existing ink without recreating strokes. `setTransform`, `remove`, `clear`,
`undo`, and `redo` are document edits. `clear()` clears completed ink; sessions
own cancellation of their drafts.

The mechanical tools are `draw`, `erase` (a continuous circular footprint), and
`erase-stroke`. One completed eraser gesture is one undo step. Erasure targets
completed strokes present when the gesture begins; subsequent ink is unaffected.
Partial erasure preserves source points and records coverage. A raw centerline
alone does not describe the remaining visible ink.

## Views and fading

`createCanvasInkView({ document, target })` displays shared ink without owning
input. `view.setViewport({ x, y, scale, rotation })` pans, zooms, and rotates without
changing the document (`rotation` is clockwise radians, default zero);
`view.evictCache()` drops only cached pixels. `view.renderCapture(capture, width,
height, density)` renders an independent canvas of frozen ink at the view's
current viewport.

`InkPresentation` supplies crossfade or hold/charge/pop effects. The pop spreads
ink outward and hollows its middle before it disappears. Set `fadeSec` and
optionally `fadeCurve` on `PencilSurface`; call `paper.refresh()` after changing
those application controls. Completed fades stay hidden when the duration changes,
including when it is set to zero. Zero keeps visible and new ink on screen.
Fading retains data by default, so captures can still show faded ink. `expireFadedInk: true`
removes expired records through a separate timer and clears the working undo
history at that expiry boundary. Captures remain valid.

`paper.fadeCompleted(seconds)` animates out the completed ink captured at the
call, then discards unchanged records. New or live ink survives. Pass `false`
as the second argument to hide that capture without removing its records.

For an overlay aligned with a scroll container's viewport, the application can
attach ink to the scrolling content:

```ts
import { bindInkAttachment } from "@habemus-papadum/aiui-pencil/canvas";

const attachment = bindInkAttachment({
  surface: paper,
  scrollTarget: scroller,
  viewport: () => ({ x: -scroller.scrollLeft, y: -scroller.scrollTop, scale: 1 }),
  resizeTargets: [scroller],
});
```

This mapping assumes the overlay shares the scroller's visible origin and does
not itself scroll. If reflow makes the mapping uncertain, call
`attachment.invalidate()` to hide the overlay and cancel local input while
preserving ink. Call `resume()` after establishing a valid mapping, and
`dispose()` when that attachment is finished.

## Input and navigation

The browser binding uses pen priority, coalesced input, provisional finger
cancellation, and palm rejection. Configure `inputOptions` on `PencilSurface` or
use `bindPenInput` directly. Automatic pen latching and explicit pen enablement
are both available; finger drawing and navigation are configurable separately.
`onSamples` reports observed/accepted input and prediction telemetry. Predictions
are not committed as real samples.

In Pencil mode, `PencilSurface` applies two-finger pan, zoom, and rotation by
default once the pen is lifted. Set `navigation: false` to disable it, or use
`navigation: { pan: true, zoom: true, rotate: false, minScale: 0.25, maxScale: 4 }`
to choose operations and zoom limits. Operation flags also accept getters for
live controls. `onViewportChange(viewport, reason)` lets the application synchronize
underlying content. The lower-level binding emits one `onNavigate` intent with
previous/current centroids, scale ratio, and angular delta.

Contacts present during writing cannot become navigation fingers until lifted.
`guardPenControls` shares the binding's activity with surrounding controls and
retains its separate cooldown. Contact-size filtering is opt-in with
`inputOptions: { palmContactPx: ... }`; a browser's reported contact dimensions
do not reliably distinguish a finger from a palm. Actual iPad pen, palm, and
Safari gesture behavior requires device testing.

## Run and verify

```sh
pnpm -C demos/circle dev
pnpm -C packages/aiui-pencil lab
LAB_INTERFACE=en0 pnpm -C packages/aiui-pencil lab
pnpm -C packages/aiui-pencil test
pnpm -C packages/aiui-pencil test:browser
pnpm -C packages/aiui-pencil typecheck
pnpm exec tsx packages/aiui-pencil/lab/benchmark-geometry.ts
```

The lab listens on all network interfaces. Choose an IPv4 interface on the iPad's
network and copy the printed URL into Safari using Universal Clipboard.
`LAB_INTERFACE` accepts an interface name or exact IPv4 address; the URL includes
the actual selected port. `--host 127.0.0.1` keeps the server local.

The lab provides geometry diagnostics, input telemetry, editable profiles,
whole/partial erasing, undo/redo, cache eviction, and a capture/review fixture.
Its patterned DOM page supports real scrolling, linked or independent ink
navigation, and deliberate reflow. Scene controls exercise pan, zoom, rotation,
and the explicit pause/resume boundary when reflow makes alignment uncertain.
Circle demonstrates live measurement followed by fading ink and a retained score.

[Architecture](./docs/architecture.md) · [Getting started](./docs/getting-started.md)
