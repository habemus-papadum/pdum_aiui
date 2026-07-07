# @habemus-papadum/aiui-paint

View and **draw on a running browser app from an iPad** (or any second device) over the LAN. The iPad
shows a live view of a desktop browser and streams pen strokes + navigation back; the desktop applies
them to its own ink layer — including, over the aiui intent overlay, straight into the intent tool.

This package is the coordination layer: the wire **protocol**, a host-neutral **backend**
(`createPaintBackend` — mounted by the aiui channel as a [sidecar](../../docs/guide/channel.md), or
by any server you own), the desktop **host** controller, and a self-contained **iPad client** page
(served by whichever host mounts the backend). It depends on
[`@habemus-papadum/aiui-ink`](../aiui-ink) for the standalone host path.

> ⚠️ **Security:** the iPad-facing surface binds the LAN and is **unauthenticated** — for a
> personal, trusted network only. The aiui channel stays loopback-only; its paint sidecar opens a
> separate LAN listener carrying only this surface, and is opt-in for exactly that reason.

## In an aiui session

```sh
aiui claude --aiui-sidecar paint    # host the paint sidecar (opt-in: LAN exposure)
aiui paint url                      # print the URL to open on the iPad
```

Pages served with the dev overlay auto-join as paintable hosts; ink drawn on the iPad lands in the
intent tool's turn.

## Fastest way to try it: the standalone demo

```sh
pnpm paint:demo        # from the repo — a bespoke Express backend + a demo app together
```

Draw on the demo's scrollable canvas with the mouse, then open the printed URL on an iPad to draw,
scroll, and pinch-zoom remotely. Click **Share screen** to send video (the real `getDisplayMedia`
path — the iPad shows "waiting" until you do, since screen capture needs a user gesture). Switch
JPEG ⇄ WebRTC with the `video:` button. Source: `packages/aiui-paint/demo/` — a compact example of
wiring `InkSurface` + `startPaintHost`, the capture-gesture handshake, and both transports.

## Host the backend yourself

```ts
import { createServer } from "node:http";
import express from "express";
import { createPaintBackend } from "@habemus-papadum/aiui-paint/server";

const backend = createPaintBackend();
const app = express();
app.use((req, res, next) => {
  if (!backend.handleHttp(req, res)) next();
});
const server = createServer(app);
server.on("upgrade", (req, socket, head) => {
  if (!backend.handleUpgrade(req, socket, head)) socket.destroy();
});
server.listen(8788, "0.0.0.0"); // the LAN bind is your posture decision
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

Video is **WebRTC** by default (smooth, low-latency, per-viewer peer connections), with **JPEG
frames** as the automatic backup — and `video: "jpeg"` to opt out of WebRTC entirely (control and
ink are identical either way). Until capture
is armed, the host reports `videoStatus: needsGesture` and the iPad shows "waiting to share" rather
than black. A host that renders its own content can pass a `canvas.captureStream()`-backed
`frameSource` and skip the gesture entirely.

## Entry points

- `@habemus-papadum/aiui-paint` — browser-safe: the protocol, `startPaintHost`, `InkSurface`.
- `@habemus-papadum/aiui-paint/server` — the host-neutral Node backend (`createPaintBackend`).
- `@habemus-papadum/aiui-paint/sidecar` — that backend packaged as an aiui channel sidecar.

Full walkthrough, gesture map, and architecture: the
[iPad Paint Stream guide](../../docs/guide/paint-stream.md) and the
[implementation plan](../../docs/proposals/ipad_browser_paint_stream_plan.md).
