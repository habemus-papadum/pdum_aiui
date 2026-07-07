# Getting Started with @habemus-papadum/aiui-paint

View and **draw on a running browser app from an iPad** over the LAN: the iPad shows a live view of a
desktop browser and streams pen strokes + navigation back, and the desktop applies them to its ink
layer (including, over the aiui intent overlay, straight into the intent tool).

> ⚠️ The iPad-facing surface binds the LAN and is **unauthenticated** — trusted networks only. The
> aiui channel stays loopback-only; its paint sidecar opens a separate LAN listener carrying only
> this surface, and is opt-in for exactly that reason.

## Install

```sh
npm install @habemus-papadum/aiui-paint
```

## 1. Host the backend

In an aiui session, one flag + one command:

```sh
aiui claude --aiui-sidecar paint    # the channel hosts it (opt-in: LAN exposure)
aiui paint url                      # prints the URL to open on the iPad
```

Or mount it on a server you own:

```ts
import { createServer } from "node:http";
import { createPaintBackend } from "@habemus-papadum/aiui-paint/server";

const backend = createPaintBackend();
const server = createServer((req, res) => {
  if (!backend.handleHttp(req, res)) {
    res.statusCode = 404;
    res.end();
  }
});
server.on("upgrade", (req, socket, head) => {
  if (!backend.handleUpgrade(req, socket, head)) socket.destroy();
});
server.listen(8788, "0.0.0.0"); // the LAN bind is your posture decision
```

## 2. Make a browser a host

Over the intent overlay (remote ink joins the intent turn):

```ts
import { startPaintHost } from "@habemus-papadum/aiui-paint";

const sink = window.__AIUI__?.remotePaint;
if (sink) {
  startPaintHost({ relayUrl: "http://your-mac.local:8788", ink: sink, label: document.title });
}
```

Standalone, onto a plain ink surface (no overlay):

```ts
import { InkSurface, inkSurfaceSink, startPaintHost } from "@habemus-papadum/aiui-paint";

const surface = new InkSurface({ fadeSec: () => 0 });
startPaintHost({ relayUrl: "http://your-mac.local:8788", ink: inkSurfaceSink(surface) });
```

## 3. On the iPad

Open the printed URL, tap the browser, tap **Arm**, pick a color and thickness, and draw. A pencil
(or a single finger, when no pencil has been used) draws; **two fingers** navigate — drag to scroll,
pinch to zoom. Palms are rejected.

The full walkthrough, gesture map, and architecture are in the
[iPad Paint Stream guide](/guide/paint-stream).
