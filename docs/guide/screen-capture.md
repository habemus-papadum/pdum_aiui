# Screen Capture: One Grant Per Page

Three features in a running aiui app need the pixels of the browser tab: the intent tool's
[screenshots](./intent-overlay), the [screen share](./realtime-live)'s sampled frames (V — each
one an ordinary screenshot, taken by the clock), and the [iPad paint stream](./paint-stream)'s
live view. All three get them from a single `getDisplayMedia` grant, taken at most once per page,
and — in the session browser — taken without ever showing you a dialog.

This page explains what the browser actually gives you, why the design is shaped the way it is, and
what a `<video>` element nobody can see is doing in the middle of it.

## What `getDisplayMedia` is, and what it is not

It is easy to reason about screen capture as a *permission*, like the microphone. It is not one, and
almost every design mistake in this area starts there.

**It is not persistable.** `navigator.permissions.query({ name: "display-capture" })` answers
`"prompt"` in every browser, on every origin, forever — including in a browser that will in fact
auto-accept the very next call. There is nothing to query and nothing to remember.

**A grant is a `MediaStream` owned by one document.** Not by an origin, not by a port, not by a
client. Two calls in the same page do not share anything: the second one opens a *second,
independent* live stream, with its own capture indicator. This is the whole reason the intent tool
and the paint host used to ask you twice — they were two callers in one page, each holding its own
grant, for one screen.

**A call cannot be cancelled.** `getDisplayMedia` takes no `AbortSignal`. Where the browser opens a
share picker, the promise simply does not settle until a human answers it. This forecloses the
obvious design — *"try it, and show a button if it fails"* — because there is no failure to catch,
only a dialog you cannot take back.

**Every call blurs the window.** `blur` fires, then `focus`, even when the grant is auto-accepted
and no dialog is ever drawn. `visibilitychange` never fires at all. Nothing in that event pair
distinguishes it from the user alt-tabbing away.

## The strategy

### One broker per document

`multimodal/display-capture.ts` owns the page's only `getDisplayMedia` call. It is created by the
intent tool's capture shell and published on `window.__AIUI__.displayCapture`, next to the
`remotePaint` ink seam — the same trick, for the same reason: two packages that must not import each
other need one object to meet on. `aiui-paint`'s host takes it as its `frameSource`, so the iPad's
video and the screenshots come from the same stream. Acquisition is single-flight, so three
consumers asking at once produce one call. The grant lives until the page does; a consumer that
closes (the paint host, say) does not end it.

### The launch marker

Whether a call needs a click is a property of the **browser process**, and the page cannot find it
out. The session browser is launched with `--auto-accept-this-tab-capture` (see
[The Agent's Browser](./chrome)), where `getDisplayMedia({ preferCurrentTab: true })` resolves in
about a third of a second with no user gesture and no picker. A personal Chrome, on the same machine
and the same dev server, opens a picker and waits.

Since the fact belongs to the browser, `aiui vite` tells the browser's pages directly: it attaches
over CDP to the endpoint it launched, and `Page.addScriptToEvaluateOnNewDocument` defines

```js
window.__AIUI_CAPTURE__ = "auto";
```

in every document there. That scope is exactly right, and two tempting alternatives leak:

- A **content script** in the aiui DevTools extension travels with the *profile*, and people install
  that extension by hand into their personal Chrome — where it would promise auto-capture in a
  browser that hangs.
- A **flag on the channel's `/health`** travels with the *port*, and a personal Chrome can open the
  same loopback page.

A CDP connection to the endpoint we launched *is* the browser process. `chrome.autoCapture: false`
opts out; the injection lives as long as the dev server's connection, and if that dies, later
documents just fall back to asking for a click.

### What the marker buys

| | Marker present (session browser) | Marker absent (a personal Chrome) |
|---|---|---|
| When the grant is taken | On **arm** — the intent tool's reconciler asserts "armed ⇒ the grant is warm" | On the first screenshot's own key press |
| First screenshot | Instant | Opens a picker, steals focus |
| iPad viewer joins | Streams immediately | Shows "📺 Share screen with iPad" until you click it |

Arm is the right demand signal: it precedes hands-free and every shot, and it means the user is
talking to *this* tab. Taking the grant there also moves the unavoidable blur off the `D`-hold,
where it used to eat the keyup and strand the crosshair veil.

### The blur guard

The blur handler in `modality.ts` stops the microphone, because a mic left open on another window
once transcribed an entire spoken conversation, segment by segment, onto the API bill. Away = mic
off. But `getDisplayMedia` blurs the window too — so the **first** screenshot of a hands-free session
silently dropped you out of hands-free mode, and every screenshot after it worked fine, because the
grant was already held and no call was made. That asymmetry *was* the bug.

`DisplayCapture.blurIsSelfInflicted()` answers "is this blur one we caused?", claiming the window
for the duration of the call plus a 750 ms grace for the trailing `focus`. The handler consults it
before stopping anything. The veil still drops unconditionally: `cancelShot` is idempotent, and a
stranded crosshair is worse than a re-armed one.

## The `<video>` element

The broker creates an `HTMLVideoElement`, points its `srcObject` at the stream, mutes it, plays it —
and never attaches it to the DOM. It exists because **`canvas.drawImage` cannot take a
`MediaStream`.** It can take a video element, so a video element is what a stream must become before
any of this works. Three consumers draw from it:

- `shot.ts` — the region and viewport screenshots, encoded as PNG. This is the one that matters.
- `shell/capture.ts` — the screen share's sampled frames (V): JPEG viewport shots that join the
  turn like any screenshot and stream to the prompt linter.
- `display-capture.ts`'s `paintFrameSource` — the paint host's **JPEG fallback** transport.

It is *not* there for the iPad. Paint's default transport is WebRTC, which takes
`stream.getVideoTracks()` and calls `pc.addTrack` — it never touches the video element. JPEG framing
is the backup for hosts with no `RTCPeerConnection` or a failed ICE negotiation. Delete the iPad
entirely and the video element still has to exist, for screenshots.

### It really does decode continuously

Measured on a live session, reading `video.getVideoPlaybackQuality()` through the published seam,
three seconds apart:

```
paused: false, readyState: 4, inDom: false, size: 2518x1388
totalVideoFrames:   12778 → 12868      (90 frames / 3.001 s ≈ 30 fps)
droppedVideoFrames: 12777 → 12867      (essentially all of them)
track settings:     { displaySurface: "browser", frameRate: 30, … }
```

So yes: for the life of the grant, the tab decodes its own capture stream at 30 fps whether or not
anybody grabs a frame. "Dropped" here means *never composited* — the element isn't in the document,
so nothing paints it — but the decode happens regardless, and that is the standing cost of holding
the grant. It begins at arm (with the marker) or at the first screenshot (without), and ends when the
page does or when you hit Chrome's "Stop sharing".

Cheaper shapes exist and are deliberately not used yet: `ImageCapture.grabFrame()`, or
`MediaStreamTrackProcessor`, would both pull frames on demand instead of running a decoder; so would
`track.applyConstraints({ frameRate: 1 })` for the sampler's cadence, at the cost of stale pixels
under the screenshot's 120 ms compositor beat. The `<video>` path works in every browser that has
`getDisplayMedia` at all, and 30 fps of nothing is a cost worth paying until it isn't.

## If you go to re-measure any of this

Two things will mislead you, and both cost real time here.

**A Chrome spawned by a process without the macOS Screen Recording grant inherits that lack.** Its
`getDisplayMedia` then *hangs* — no dialog, no rejection, no blur — even with
`--auto-accept-this-tab-capture`, because the auto-accept path still goes through the desktop-media
plumbing. It looks exactly like "the flag doesn't work". A dozen careful probes from an agent's
sandboxed shell all reported a flag that was working perfectly in the browser the user had launched
from their own terminal a metre away. If `screencapture -x /tmp/x.png` fails from your shell, no
measurement of capture taken from that shell means anything. Test in a browser started from a real
terminal — or headless, where there is no picker plumbing to stall.

**A browser left holding an unanswered picker stays poisoned.** The next `getDisplayMedia` in that
process queues behind it and hangs too. Quit the browser and relaunch before believing a negative
result.

And one flag that looks helpful and is not: `--use-fake-ui-for-media-stream` hijacks the picker and
auto-selects the *entire screen*, which needs the OS screen-recording grant that Chrome for Testing
does not have. Every capture then dies with `NotReadableError: Could not start video source`,
silently defeating the tab-capture flag. `aiui` passes
`--auto-accept-camera-and-microphone-capture` instead, which covers only the mic and camera prompts.
