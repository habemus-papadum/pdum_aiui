# @habemus-papadum/aiui-screen-capture

Own a browser screen-capture session, expose its `MediaStream`, and preview it with Solid controls.
Capture a tab, window, or display; crop this tab to an element's rectangle or isolate the element
and its descendants. No network transport or credentials are involved.

```tsx
import { createScreenCapture } from "@habemus-papadum/aiui-screen-capture";
import {
  ScreenCaptureControl,
  ScreenCapturePreview,
  ScreenCaptureTarget,
} from "@habemus-papadum/aiui-screen-capture/widgets";

const capture = createScreenCapture(); // Application owns and eventually disposes this.
let chart!: HTMLDivElement;

<ScreenCaptureControl capture={capture}
  targets={[{ label: "Chart", element: () => chart }]} />;
<ScreenCaptureTarget ref={(element) => { chart = element; }} label="Chart">
  {/* Your chart or other content. */}
</ScreenCaptureTarget>;
<ScreenCapturePreview capture={capture} />;
```

Region mode can target any connected DOM element. Element-only mode requires a **declared capture
boundary**. `ScreenCaptureTarget` declares one, labels it, and supplies `isolation: isolate` and
`transform-style: flat`. These styles are applied when building the UI, so stacking and blending
behavior stays consistent when capture starts. Give the boundary an opaque background if the
preview should have one; captured video has no alpha channel.

To declare an existing JSX element without adding a wrapper, spread `captureTargetProps`:

```tsx
import { captureTargetProps } from "@habemus-papadum/aiui-screen-capture";

<section {...captureTargetProps("Plot")} class="plot">
  {/* This section is the boundary, including all its descendants. */}
</section>;
```

The helper supplies `data-screen-capture-target`, `data-capture-label`, and the two isolation
styles. Keep those styles when adding inline styles, or use a class for other styling. The picker
does not add styles to arbitrary elements. In Element-only mode it highlights the nearest declared
boundary under the pointer, including when hovering over text or SVG inside it. Nested boundaries
are supported; the up/down keys move between boundaries. Region mode continues to select individual
elements. Declaring a boundary does not request permission or start capture.

## Controller

```ts
// Call start directly from a click/key gesture. The user chooses the source in the browser.
await capture.start({ target: { element: chart, label: "Chart", mode: "region" } });
const stream = capture.stream(); // Borrow it; do not stop or clone its tracks.
await capture.setTarget({ element: chart, mode: "element" });
await capture.setTarget(null);   // Restore the whole selected surface; no new picker.
const off = capture.subscribe((snapshot) => console.log(snapshot));
capture.stop();                  // Release all owned tracks.
off();
capture.dispose();               // Final teardown; the controller cannot be restarted.
```

`start()` accepts `target`, `preferCurrentTab` (default false for full-surface capture; always true
with a crop target), and desired `frameRate` (default 30). Full-surface capture requests the general
source chooser; the browser decides which tabs, windows, and displays it offers. Each `start()`
opens a new browser request: screen-sharing grants cannot be cached, whereas `setTarget()` reuses
the current stream without prompting. It returns the owned stream, or `undefined` if
stopped/disposed before acquisition finished.
An acquisition failure rejects and updates `snapshot().error`. Declining replacement preserves
the existing capture. Concurrent browser pickers are rejected. A browser picker cannot be closed
programmatically; a grant that arrives after Stop is released immediately.

Snapshots report state, outstanding picker/crop operations, browser mute state, source label/type,
track dimensions/reported frame rate, and the applied crop's label/mode/DOM availability, including
an `unavailableReason` for hidden, removed, offscreen, or improperly styled targets. `capture.target()` returns the applied target for synchronizing custom controls. State
subscriptions deliver immediately, then on changes. The browser owns resizing; metadata and target
availability are sampled at 2 Hz, with ended/mute/unmute events handled immediately.

The first stream is exposed only after its requested crop has applied. Crop changes are serialized
and replace the native target directly, without first clearing it or toggling the track. Frames from
the previous crop may continue until the new crop applies. Element-only requests for undeclared
or improperly styled boundaries are rejected before acquisition/native cropping and preserve an
existing crop. A failed native crop transition stops the capture;
there is no automatic fallback to sharing a larger surface. Clearing a crop explicitly restores
full-surface capture. A hidden or detached target stays cropped: show it again, select another
connected target, or clear the crop. DOM replacements (including HMR) require a new target.

## Crop modes

| Mode | Result | Native API |
| --- | --- | --- |
| `region` | The element's rectangle as it appears in the tab, including overlapping content | `CropTarget` / `cropTo()` |
| `element` | The element and its descendants, excluding overlapping siblings | `RestrictionTarget` / `restrictTo()` |

Native cropping follows scrolling, resizing, and layout changes without a JavaScript frame-copy
loop. Native cropping is limited to the captured tab's viewport; keep the target in view.
An entirely offscreen target may stop producing frames. Neither mode is a
DOM screenshot renderer. Modes are feature-detected independently. Current implementations require capturing the same
tab that contains the target. Choosing another tab, a window, or a display cannot crop to an element
on this page. The native call is authoritative and may reject even when the API exists. A restricted
element that is hidden or becomes ineligible may stop producing frames until eligible again.

Cropping is optional: full-surface capture works wherever `getDisplayMedia` is supported. The
controller reports unsupported crop modes; it does not emulate them by rasterizing the DOM.

## Widgets

- `ScreenCaptureControl`: Share/Change source, Stop, named target selection, region/element mode,
  capability explanations, Pick an element, and Show target (scroll it into view). Choosing a target before sharing applies it before
  exposing the stream. Choosing one during capture updates the existing stream.
- `ScreenCapturePreview`: a muted inline video, dimensions, source/crop label, and measured preview
  FPS. It explains unavailable targets and missing initial frames; a static image at zero FPS
  remains a valid preview. A play button appears if playback needs a gesture. Unmounting it does not stop capture.
  It rebinds its video when the applied target/mode changes: Chromium can otherwise retain the
  preceding crop frame despite the native crop promise resolving. The underlying stream and tracks
  remain the same; other consumers should validate their own handling of native crop transitions.
- `ScreenCaptureTarget`: declares a boundary with isolation CSS and a human label.
- `useScreenCaptureState(capture)`: Solid subscription for custom UI.

`pickCaptureElement({ root?, signal?, mode? })` is also available without Solid. The default mode
is `region`; `element` selects declared boundaries only and rejects when none are available in the
root. Hover highlights a target; click or Enter selects; Escape cancels; up/down arrows move to the
parent/first child (parent/descendant boundaries in Element-only mode). The picker
suppresses the selection click's normal action, follows scrolling, cancels on blur/abort, and excludes
`[data-screen-capture-ignore]` elements. `pickerRoot` on the control limits selection to a subtree.

Preview FPS is measured using video-frame presentation metadata. It is distinct from the track's
reported frame rate, can fall on static content, and is unavailable when the document is hidden or
the browser lacks frame callbacks. It is not a network throughput or encoder statistic.

## Electron

The controller and Solid widgets run in a renderer and use standard `MediaStream`/video APIs.
An Electron host can configure `session.setDisplayMediaRequestHandler()` in its main process,
selecting a source via `desktopCapturer`, while this package keeps using `getDisplayMedia()`.
The optional `driver` argument to `createScreenCapture` also allows a custom acquisition/cropping
adapter (and deterministic tests). Any supplied stream's tracks transfer ownership to the controller.

Electron may choose sources and grant renderer-level permissions for its trusted application, but
macOS Screen Recording consent remains an OS decision. DOM cropping requires a supported browser
capture track of the target's own page; it cannot select DOM elements inside a captured native app
or crop a native window to arbitrary screen coordinates. Renderer preview compatibility and native
cropping should be checked against the Electron version and source type; this package's browser
suite does not claim an Electron integration test. Hidden renderer frame statistics may be throttled.

## Demo and validation

`pnpm -C demos/screen-capture dev` runs the demo; the gallery also discovers it at `/screen-capture`.
The demo stops capture when its page is deactivated. No existing pencil consumer has been migrated.

```sh
pnpm -C packages/aiui-screen-capture test
pnpm -C packages/aiui-screen-capture exec playwright install chromium
pnpm -C packages/aiui-screen-capture test:browser
pnpm -C packages/aiui-screen-capture typecheck
pnpm -C packages/aiui-screen-capture build
```

Unit tests inject streams and crop operations to cover permission/crop races, source replacement,
track ownership, native-token reuse, and failures. Browser tests use an animated canvas for preview
lifecycle and real headless Chromium tab capture for crop geometry, scrolling, target switches,
clearing, and pixel-level overlap/isolation checks. Full Chromium (`channel: chromium`) is necessary;
Playwright's smaller headless shell does not provide the same tab-capture path. Automation flags
approve only the test's own browser tab. Tests wait for fresh frames after visibility/scroll changes
rather than treating cached video pixels as evidence of recovery. Regression tests cover picking
paragraphs inside declared boundaries, invalid API targets, CSS eligibility loss/recovery, and
preserving the stream across mode changes. They verify native pixels without
forcing screenshots or changing page content to refresh the capture. Test your chosen browser/Electron
version for native cropping. Tests also exercise the picker and demo at desktop/phone sizes.

Browser references: [Screen Capture](https://www.w3.org/TR/screen-capture/),
[Region Capture](https://developer.chrome.com/docs/web-platform/region-capture),
[Element Capture](https://developer.chrome.com/docs/web-platform/element-capture),
[frame callbacks](https://wicg.github.io/video-rvfc/),
[Electron capture handler](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts),
[Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer).
