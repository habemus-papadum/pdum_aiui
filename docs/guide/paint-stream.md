# iPad Paint Stream

Draw on a running browser app **from an iPad** (or any second device). The iPad shows a live view of
a desktop browser, and your Apple Pencil ink lands on that browser — including, when you're pointing
at an [intent overlay](./intent-overlay), directly into the intent tool's ink layer, so a circle you
draw on the iPad travels into the screenshot and the prompt just like ink drawn with a mouse.

This is the picture the design note
[iPad-Controlled Browser Painting Stream](/proposals/ipad_browser_paint_stream_design) sketched; the
[implementation plan](/proposals/ipad_browser_paint_stream_plan) records what was built and where it
diverges (notably: JPEG-frame streaming over a websocket relay today, with a seam for WebRTC later).

::: danger Read before running
The relay binds the **LAN** and is **unauthenticated** — by design, for a personal trusted network.
Anyone who can reach the port can view and draw on the connected browser. Use it only on a network
you trust, and don't run it on café Wi-Fi. It is a *separate* process from the channel MCP server;
the channel server's loopback-only posture is unchanged. See [Read before running](./warning).
:::

## The pieces

- **`@habemus-papadum/aiui-ink`** — a reusable canvas ink surface: local pointer inking or a remote
  stroke feed, per-stroke color and thickness, optional fade, screenshot compositing. Framework-free
  and useful on its own (handwriting math, sketching) independent of the stream.
- **`@habemus-papadum/aiui-paint`** — the coordination layer: the wire protocol, the **relay**
  server, the desktop **host** controller, the **iPad client** (served by the relay), and a CLI.

```
   iPad (client)                relay (LAN)                 desktop browser (host)
   ┌───────────────┐   ws /client   ┌──────────┐   ws /host   ┌────────────────────┐
   │ live video    │◀───frames──────│  pairs a │◀───frames────│ getDisplayMedia →  │
   │ pen → strokes │────intents────▶│  host +  │────intents──▶│ JPEG frames        │
   │ arm · color   │                │  viewers │              │ applies strokes to │
   │ scroll · pinch│    /sessions   └──────────┘              │ the ink layer      │
   └───────────────┘                                          └────────────────────┘
```

## Run it

**1. Start the relay** (on the machine running the browser):

```sh
pnpm paint            # or: aiui-paint  (the package bin)
```

It prints the LAN URLs to open and the security warning:

```
  Open the iPad client at one of:
    http://10.0.0.7:8788/
  ⚠️  This binds the LAN and is UNAUTHENTICATED — use only on a trusted network.
```

**2. Make a browser a host.** The desktop page has to run the host controller so it appears in the
iPad's list. If your app mounts the intent overlay, wire it to the overlay's ink seam:

```ts
import { startPaintHost, hostWsUrl } from "@habemus-papadum/aiui-paint";

const sink = window.__AIUI__?.remotePaint; // published by the multimodal intent tool
if (sink) {
  startPaintHost({
    relayUrl: "http://<your-mac>.local:8788",
    ink: sink,
    label: document.title,
    channelPort: window.__AIUI__?.port, // enriches the iPad's session list from the registry
  });
}
```

Or draw onto a **standalone** surface (no overlay) — the reusable `aiui-ink` path:

```ts
import { InkSurface, inkSurfaceSink, startPaintHost } from "@habemus-papadum/aiui-paint";

const surface = new InkSurface({ fadeSec: () => 0 }); // a full-viewport ink canvas
startPaintHost({
  relayUrl: "http://<your-mac>.local:8788",
  ink: inkSurfaceSink(surface),
  label: "my app",
});
```

**3. On the iPad**, open the printed URL in Safari, tap the browser you want, tap **Arm**, pick a
color and thickness, and draw. The first frame prompts the desktop once for screen-capture (auto-
accepted in the session browser).

## Interacting from the iPad

Navigation is always available; drawing only happens while **armed**.

| Input | Armed | Not armed |
| --- | --- | --- |
| Apple Pencil / mouse | Draw a stroke | — |
| One finger drag | Scroll | Scroll |
| Two fingers | Pinch-zoom + pan | Pinch-zoom + pan |

Vertical scroll is the reliable one; zoom is approximate by default (the host accumulates a CSS
transform) — an app with its own viewport model can pass a real `onZoom` handler to
`startPaintHost({ nav: { zoom } })`.

## How coordinates work

The iPad sends every point normalized to `0..1` within the *displayed* (letterboxed) video area — it
never sends pixels. The host re-maps each point against its **own** current surface size, so the same
stroke is correct whether the iPad is portrait, landscape, or a different device entirely. The design
rule is: the desktop owns coordinate mapping (see `toNorm` / `fromNorm` in the protocol).

## Reusing just the ink surface

`aiui-ink`'s `InkSurface` is independent of the stream. Local drawing plus a remote feed, styled per
stroke:

```ts
import { InkSurface } from "@habemus-papadum/aiui-ink";

const surface = new InkSurface({
  color: () => "#4cc9f0",
  width: () => 6,
  fadeSec: () => 0,        // persist (set > 0 to make ink evaporate)
  onStrokeEnd: (s) => console.log("drew", s.points.length, "points"),
});

// feed a stroke from anywhere (points in the surface's CSS pixels):
surface.remoteBegin("s1", { style: { color: "#f00", width: 4 }, point: { x: 20, y: 20 } });
surface.remotePoint("s1", { x: 80, y: 60 });
surface.remoteEnd("s1", { x: 140, y: 20 });
```

## Limitations and seams

- **Video is JPEG frames** (~8 fps, downscaled), not WebRTC — fine for annotating, not for video. The
  protocol reserves an opaque `signal` passthrough so WebRTC can be added later with no relay change.
- **No Bonjour discovery** — Safari web pages can't browse mDNS, so the CLI prints LAN URLs instead.
- **One trust boundary** — no auth, no encryption. LAN only.
