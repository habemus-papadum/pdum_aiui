# Element Capture & the Capture Plane

Status: **exploratory** — a design note, not committed work (July 2026). Companions:
[Intent Overlay](../guide/intent-overlay.md) (what the widget is), [Realtime Live
Mode](../guide/realtime-live.md) (where share frames go), and
[ipad_browser_paint_stream_design.md](./ipad_browser_paint_stream_design.md) (the other consumer
of the same capture grant).

## The ask

Screenshots and share frames currently contain the intent tool itself — the command bar (the
pill/panel) and the transcript preview strip. Neither is part of the app under discussion, and
both are plausibly *confusing* to the model: a transcript of what the user just said, rendered as
pixels, alongside the words already arriving as text.

Can we exclude specific widgets from the capture? With a hard constraint: **no hacks.** Not
"hide the chrome for one frame and hope the compositor keeps up." A first-class browser mechanism
that lets the compositor do the work efficiently, or nothing.

The answer is yes, with one twist and one surprise. The twist is that the platform offers
*inclusion*, not exclusion. The surprise is that chasing it exposed a real bug in how ink reaches
the model.

## The mechanism: Element Capture

[Element Capture](https://screen-share.github.io/element-capture/) (Chrome 132+, desktop, W3C
Screen Capture extension) restricts a self-capture video track to a single DOM subtree:

```js
const stream = await navigator.mediaDevices.getDisplayMedia({ preferCurrentTab: true });
const [track] = stream.getVideoTracks();                       // BrowserCaptureMediaStreamTrack
const target = await RestrictionTarget.fromElement(captureRoot);
await track.restrictTo(target);                                // restrictTo(null) lifts it
```

The spec's own words are the whole story:

> Calls to `restrictTo(restrictionTarget)` mutate the video track into a capture of
> `captureTarget`, **as though it were drawn by itself, independently of the rest of the DOM**.
> Any descendants of `captureTarget` are also captured; siblings of `captureTarget` are
> eliminated from the capture. […] any **occluding and occluded content are removed**.

That last clause is what makes it the right primitive and rules out its older sibling. Region
Capture (`CropTarget` / `cropTo()`) crops frames to a target's bounding box but keeps whatever is
painted *on top* of that box — useless here, since our widgets float over the page by
construction. Element Capture removes occluders. It is implemented in the compositor: the target
gets its own render surface and that surface is what the track emits. No readback, no per-frame
JS.

Verified in the session browser (Chrome 150, `localhost`, secure context):

```json
{ "elementCapture": true, "fromElement": "function",
  "BrowserCaptureMediaStreamTrack.restrictTo": "function",
  "CropTarget": true, "cropTo": "function" }
```

### The details that bite

**Eligibility is CSS, and it is checked.** `RestrictionTarget.fromElement()` rejects an element
that is not eligible. The union of the spec's list and MDN's:

| Requirement | How you satisfy it |
| --- | --- |
| Forms a stacking context | `isolation: isolate` (or `position: relative; z-index: 0`) |
| Flattened in 3D | `transform-style: flat`; no `perspective`, no 3D transforms |
| Forms a backdrop root | implied by `isolation: isolate` |
| Exactly one box fragment | a block box; not fragmented across columns/lines |
| Is rendered | not `display: none`, not `visibility: hidden` |

**The alpha channel is dropped.** A restricted capture of a transparent element produces opaque
pixels. The target wants an explicit `background-color`.

**Ineligible mid-stream means no frames.** If the target stops satisfying the rules while the
track is live (an HMR swap that momentarily `display: none`s the app root, say), Chrome stops
emitting frames — it does not emit wrong ones. Any adoption needs a watchdog that calls
`restrictTo(null)` and reports, rather than a share that silently goes black.

**One track, one restriction, and clones are fatal.** In Chromium `restrictTo()` **rejects if the
track has clones**, and `RestrictionTarget.fromElement()` on a cloned element yields nothing. We
hold exactly one `getDisplayMedia` stream (`display-capture.ts:151`, `preferCurrentTab: true`) and
there is no `.clone()` anywhere in the repo — so restriction is document-wide by construction. The
shot path, the ~1 fps sampler, and the iPad paint sidecar's frame source
(`paint-host.ts:120`) all see the same restricted frames. You cannot show the human's iPad mirror
one thing and the model another without cloning, and cloning is precisely what makes `restrictTo`
reject.

**Frames become the target's box, not the viewport.** Restriction crops to the element's contours.
Whatever we restrict to had better be viewport-shaped, or every coordinate mapping downstream
changes. (Measured on the blank `demos/july09`: `#root` is 1526×88 against a 1526×1215 viewport.
It is not a capture surface; it's a content box that happens to be at the top of one.)

## The current situation

`document.body`'s children, live:

```
#root                      the app
<script>
aiui-intent-tool-host      shadow root: pill, panel, toasts        ← the command bar
.mm-layers                 ink canvas, shot veil, transcript preview
```

`.mm-layers` is a bare div appended at `modality.ts:430`; its three children are all
`position: fixed`. The widget host is a separate shadow-DOM element (`intent.ts:330`). So the two
things we want gone from the capture live in two different subtrees, and the ink — which we
emphatically want *kept* — lives in the same subtree as one of them.

### The double-draw

`.mm-ink` is `position: fixed; inset: 0; z-index: 2147483640` (`styles.ts:9`) and is never hidden.
Tab capture composites the tab, so **ink is already in the captured video**. And then `grab()`
draws it a second time (`shot.ts:230`):

```ts
ctx.drawImage(video, …);                              // the frame — ink included
this.ink.compositeInto(ctx, rect.x, rect.y, scaleX);  // the same ink, again
```

Confirmed empirically rather than assumed. With `.mm-ink { visibility: hidden }` forced on the
live page, a viewport shot of a single `#ff5c87` stroke still came back with 5,344 pixels of
`rgb(255, 92, 135)` in a band at image y≈757 — exactly where a viewport-y 608 stroke lands under
the 1.25× scale. The capture contributed nothing (the canvas was invisible); `compositeInto` drew
all of it. Un-hide the canvas — the normal state — and both sources fire.

For opaque ink this is idempotent-looking and merely wasteful. It stops being either as soon as
ink is *fading*, because the two sources disagree. `compositeInto` deliberately draws at `FULL`
(`ink.ts:270`):

> Always at FULL style, never mid-warp: a shot freezes what you *circled*, and a stroke caught two
> frames before it popped should reach the model as the annotation it is, not as a half-erased
> ghost.

The intent is right. The implementation means a shot taken mid-warp contains the on-screen stroke
(faded, stretched, glowing) *underneath* a crisp full-opacity stroke — a haloed double image. And
the share path disagrees with the shot path: `captureVideoFrame()` (`shell/capture.ts:319`) does
no compositing at all, so a share frame shows the honest, faded stroke. Two capture paths, two
different pictures of the same ink.

So the user's instinct is correct: **ink should come straight from the capture.** It is on the
page; the compositor already has it; drawing it again in software is a workaround for a problem
(the fade clock) that has a better fix.

There is one more piece of scenery worth naming. `grab()` sleeps 120 ms before reading the frame
(`shot.ts:207`) so the shot veil — which we just hid — is actually gone from the compositor's
output. That latency exists only because the veil is in the capture.

## Possible solutions

### 1. A capture plane the app provides (recommended)

Make the app under development a deliberate participant. The scaffold (`create-aiui`'s
`templates/app/index.html`, and therefore `pnpm new-demo`) ships a capture root, and the overlay
mounts the ink *inside* it while chrome stays outside:

```html
<body>
  <div id="aiui-capture-root">   <!-- restriction target -->
    <div id="root"></div>        <!-- the app -->
    <!-- overlay injects the ink canvas here -->
  </div>
  <!-- overlay injects chrome out here: preview, veil, widget host -->
</body>
```

```css
#aiui-capture-root {
  position: fixed; inset: 0;     /* viewport-shaped: coordinate math unchanged */
  isolation: isolate;            /* stacking context + backdrop root */
  transform-style: flat;
  background-color: Canvas;      /* restriction drops alpha */
}
```

The overlay feature-detects, calls `RestrictionTarget.fromElement(captureRoot)` once per grant,
and `restrictTo`s the single shared track. Everything follows:

- Command bar and transcript preview are siblings of the target → gone from every shot and every
  share frame. The original ask, satisfied by the compositor.
- Ink is a descendant → captured natively, once, at whatever opacity it actually has.
- `compositeInto()` is deleted from `grab()`. The double-draw cannot recur, because there is only
  one source of ink pixels.
- The shot veil moves outside the target → the 120 ms beat in `grab()` goes away.
- Shots and share frames finally agree, because they read the same restricted track.

The `FULL`-style guarantee that `compositeInto` was protecting is preserved properly: **freeze the
fade clock while a shot is in flight** (`ink.freeze()` / `ink.thaw()` around `grab()`) instead of
re-drawing the strokes. That is what the comment was reaching for — the stroke you circled should
not evaporate between the keypress and the encode — and it is one clock, not a second renderer.

Costs, honestly: the overlay now imposes a stacking context and an opaque background on a wrapper
around the app's root, which can change how the app's own `z-index`/blend layers compose against
the page. It is Chrome-desktop-only — acceptable, since the overlay is dev-gated and this repo
already assumes the Chrome session browser, but it must degrade silently. It needs the watchdog
for mid-stream ineligibility. And the iPad mirror inherits the restriction; I think that's
desirable (the pencil draws on the app, not on our pill) but it is a decision, not a detail.

For apps that predate the template, the overlay can construct the wrapper at runtime and reparent
`#root` into it. That keeps the mechanism universal and makes the template's markup an
*optimization of clarity*, not a hard dependency — but the reparenting path deserves its own
scrutiny before we lean on it.

### 2. Fix the double-draw now, independently of any of this

Delete `compositeInto()` from `grab()`, add the fade-freeze, and let the existing unrestricted
capture supply the ink it already supplies. No new browser APIs, no DOM restructuring, no
Chrome-version floor. This is strictly correct today: it removes the halo, makes the shot path
agree with the share path, and deletes a renderer.

It does nothing for the original ask. But it is a prerequisite for option 1 in everything but
name, it is small, and it can ship on its own. **If we do only one thing, do this one.**

### 3. Element Capture, keeping ink outside and composited

Restrict to a wrapper around `#root` only; leave `.mm-layers` outside; keep `compositeInto()` for
shots and *add* an equivalent composite to `captureVideoFrame()`. Chrome and preview disappear
from the capture; ink is re-drawn in software on both paths, so at least they agree.

Simpler DOM than option 1 — the ink canvas never moves. But it enshrines software ink compositing
as permanent architecture, doubles the code that has to know how to draw a stroke into a frame,
and keeps the fade/`FULL` divergence alive by design. It is the fallback if reparenting or the
stacking-context imposition turns out to be unacceptable.

### Rejected

**Region Capture (`cropTo`)** keeps occluding content by definition. Our widgets are occluders.
It cannot express this.

**Hide-the-chrome-for-a-frame.** Toggle `visibility` on the widget and the preview, wait a
compositor beat, capture, restore. This is the hack the ask explicitly forecloses, and we already
have a taste of what it costs: the 120 ms sleep in `grab()` is exactly this pattern for the veil,
and it buys latency, a flicker risk, and a race with the encode. It also cannot work at all for
the ~1 fps share stream, which has no discrete moment to hide anything.

## Ranking

1. **Option 2** — fix the double-draw. Cheap, obviously correct, ships alone, unblocks the rest.
2. **Option 1** — the capture plane. The real answer to the ask, and it *deletes* code rather than
   adding a second renderer. Do it once option 2 has landed and the ink path has one owner.
3. **Option 3** — only if option 1's DOM contract proves invasive in practice.

## Open questions

- What does Chrome emit when the restriction target is **taller than the viewport** (a scrolling
  document)? The `position: fixed; inset: 0` capture root sidesteps this, but a template that
  wants a normally-flowing root does not, and I have not measured it.
- Does `isolation: isolate` on the wrapper measurably change rendering for the gallery demo's
  WebGL/canvas layers?
- Restriction is per-track and the track is shared. Is there any consumer that genuinely wants the
  *unrestricted* view? (`aiui-paint`'s iPad mirror is the only candidate, and it probably doesn't.)
- The watchdog: how do we detect "frames stopped because the target went ineligible" as distinct
  from "frames stopped because the user hit Stop sharing"? The `ended` listener in
  `display-capture.ts` covers the second; the first is silent.

## References

- [Element Capture — W3C draft](https://screen-share.github.io/element-capture/)
- [Chrome for Developers: Capture a video stream from any element](https://developer.chrome.com/docs/web-platform/element-capture)
- [MDN: `BrowserCaptureMediaStreamTrack.restrictTo()`](https://developer.mozilla.org/en-US/docs/Web/API/BrowserCaptureMediaStreamTrack/restrictTo)
- [MDN: `RestrictionTarget.fromElement()`](https://developer.mozilla.org/en-US/docs/Web/API/RestrictionTarget/fromElement_static)
- [MDN: Using the Element Capture and Region Capture APIs](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Capture_API/Element_Region_Capture)
