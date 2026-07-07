# @habemus-papadum/aiui-paint

View and **draw on a running browser app from an iPad** (or any second device) over the LAN. The iPad
shows a live view of a desktop browser and streams pen strokes + navigation back; the desktop applies
them to its own ink layer — including, over the aiui intent overlay, straight into the intent tool.

This package is the coordination layer: the wire **protocol**, a LAN **relay** server, the desktop
**host** controller, a self-contained **iPad client** (served by the relay), and a CLI. It depends on
[`@habemus-papadum/aiui-ink`](../aiui-ink) for the standalone host path.

> ⚠️ **Security:** the relay binds the LAN (`0.0.0.0`) and is **unauthenticated** — for a personal,
> trusted network only. It is a separate process from the loopback channel MCP server, whose posture
> it does not change.

## Fastest way to try it: the standalone demo

```sh
pnpm paint:demo        # from the repo — starts the relay + a demo app together
```

Draw on the demo's scrollable canvas with the mouse, then open the printed URL on an iPad to draw,
scroll, and pinch-zoom remotely. Click **Share screen** to send video (the real `getDisplayMedia`
path — the iPad shows "waiting" until you do, since screen capture needs a user gesture). Switch
JPEG ⇄ WebRTC with the `video:` button. Source: `packages/aiui-paint/demo/` — a compact example of
wiring `InkSurface` + `startPaintHost`, the capture-gesture handshake, and both transports.

## Run the relay

```sh
npx aiui-paint         # prints LAN URLs to open on the iPad, and the warning
```

## Make a browser a host

Over the intent overlay (remote ink joins the intent turn):

```ts
import { startPaintHost } from "@habemus-papadum/aiui-paint";

const sink = window.__AIUI__?.remotePaint;
if (sink) {
  startPaintHost({ relayUrl: "http://your-mac.local:8788", ink: sink, label: document.title });
}
```

Standalone (a plain ink surface, no overlay):

```ts
import { InkSurface, inkSurfaceSink, startPaintHost } from "@habemus-papadum/aiui-paint";

const surface = new InkSurface({ fadeSec: () => 0 });
const host = startPaintHost({ relayUrl: "http://your-mac.local:8788", ink: inkSurfaceSink(surface) });

// Screen capture (getDisplayMedia) needs a user gesture — call from a click, not on connect.
shareButton.addEventListener("click", () => host.requestCapture());
```

Video is **JPEG frames** by default; pass `video: "webrtc"` to `startPaintHost` for a smooth,
low-latency WebRTC peer connection instead (control and ink are identical either way). Until capture
is armed, the host reports `videoStatus: needsGesture` and the iPad shows "waiting to share" rather
than black. A host that renders its own content can pass a `canvas.captureStream()`-backed
`frameSource` and skip the gesture entirely.

## Entry points

- `@habemus-papadum/aiui-paint` — browser-safe: the protocol, `startPaintHost`, `InkSurface`.
- `@habemus-papadum/aiui-paint/relay` — the Node relay (`startPaintRelay`) — `http`/`ws`/`express`.
- `aiui-paint` (bin) — start the relay from the command line.

Full walkthrough, gesture map, and architecture: the
[iPad Paint Stream guide](../../docs/guide/paint-stream.md) and the
[implementation plan](../../docs/proposals/ipad_browser_paint_stream_plan.md).
