# Getting Started with @habemus-papadum/aiui-paint

View and **draw on a running browser app from an iPad** over the LAN: the iPad shows a live view of a
desktop browser and streams pen strokes + navigation back, and the desktop applies them to its ink
layer (including, over the aiui intent overlay, straight into the intent tool).

> ⚠️ The relay binds the LAN and is **unauthenticated** — trusted networks only. It is a separate
> process from the loopback channel MCP server, whose posture it does not change.

## Install

```sh
npm install @habemus-papadum/aiui-paint
```

## 1. Start the relay

```sh
npx aiui-paint        # prints the LAN URLs to open on the iPad
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

Open the printed URL, tap the browser, tap **Arm**, pick a color and thickness, and draw. One finger
scrolls; two fingers pinch-zoom.

The full walkthrough, gesture map, and architecture are in the
[iPad Paint Stream guide](/guide/paint-stream).
