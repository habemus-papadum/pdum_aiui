# iPad Paint Stream

Draw on a running browser app **from an iPad** (or any second device). The iPad shows a live view of
a desktop browser, and your Apple Pencil ink lands on that browser — including, when you're pointing
at an [intent overlay](./intent-overlay), directly into the intent tool's ink layer, so a circle you
draw on the iPad travels into the screenshot and the prompt just like ink drawn with a mouse.

This is the picture the design note
[iPad-Controlled Browser Painting Stream](/proposals/ipad_browser_paint_stream_design) sketched; the
[implementation plan](/proposals/ipad_browser_paint_stream_plan) records what was built and where it
diverges. Video ships in two flavours: **WebRTC** (the default — smooth, low-latency, peer-to-peer)
with **JPEG frames** over the websocket as the simple, works-everywhere option — and the automatic
backup when WebRTC can't run or its connection fails. Control and ink are identical either way.

::: danger Read before running
The paint surface is **unauthenticated** — by design, for a personal trusted network. Anyone who
can reach the port can view and draw on the connected browser. In an aiui session it rides the
channel's **one port**, so who can reach it is the channel's bind decision (`channel.bind`, asked
at first run): `loopback` keeps everything this-machine-only (the iPad then needs a tunnel you
own — Tailscale, `ssh -L`); `host` puts the whole channel surface on your LAN. Use `host` only on
a network you trust, and don't run it on café Wi-Fi. See [Read before running](./warning).
:::

## The pieces

- **`@habemus-papadum/aiui-ink`** — a reusable canvas ink surface: local pointer inking or a remote
  stroke feed, per-stroke color and thickness, optional fade, screenshot compositing. Framework-free
  and useful on its own (handwriting math, sketching) independent of the stream.
- **`@habemus-papadum/aiui-paint`** — the coordination layer: the wire protocol, a host-neutral
  **backend** (`createPaintBackend`, mountable on any HTTP server — the channel hosts it as a
  [sidecar](./channel#sidecars), the demo hosts it on a bespoke Express server), the desktop
  **host** controller, and the **iPad client** page (served by whichever host mounts the backend).

```
   iPad (client)              paint backend                desktop browser (host)
   ┌───────────────┐   ws …/client  ┌──────────┐  ws …/host   ┌────────────────────┐
   │ live video    │◀───frames──────│  pairs a │◀───frames────│ getDisplayMedia →  │
   │ pen → strokes │────intents────▶│  host +  │────intents──▶│ JPEG frames        │
   │ arm · color   │                │  viewers │              │ applies strokes to │
   │ scroll · pinch│   …/sessions   └──────────┘              │ the ink layer      │
   └───────────────┘                                          └────────────────────┘
```

## In an aiui session: the paint sidecar

The paint sidecar is **always hosted** — every channel mounts it (along with the other standard
sidecars) on its own web server (mounted at `/paint`, one port, no extra process or listener), so
hosting it costs nothing until something connects. The integrated flow — the iPad draws into the
intent tool of the app your agent session is serving — is one choice and one command:

```sh
aiui claude          # first interactive launch asks where the channel binds; answer "host"
aiui paint url       # prints the URL to open on the iPad
```

Everything hangs off the channel's **bind**:

- The **desktop browser** connects locally either way: the app page already knows the channel port
  (`window.__AIUI__.port`), so the overlay's paint host connects with zero configuration — any
  page served with the dev overlay (turn-hosting views) auto-joins as a paintable host when the
  sidecar answers `GET /paint/info`.
- The **iPad** opens `http://<your-machine>:<channelPort>/paint/`. With `channel.bind: "host"`
  (the trusted-LAN posture — see the warning above) that URL works from anywhere on your network;
  `aiui paint url` prints the exact LAN URL(s) to copy across (on a Mac, Universal Clipboard
  pastes straight to the iPad). With the default `loopback` bind, nothing off this machine can
  reach the port — getting the iPad there is then a tunnel of your own making (Tailscale, an
  `ssh -L <port>:127.0.0.1:<channelPort>` forward from a machine the iPad can reach, …), and
  `aiui paint url` reminds you of that instead of printing LAN URLs.

The durable switch is [`channel.bind`](./config#all-keys) (asked once at first run, like
skip-permissions); `--aiui-bind host|loopback` overrides it per launch. There is no per-sidecar
off switch — the bind is the only knob, because it is the only thing that decides who can reach the
port.

Arming from the iPad arms the intent turn; strokes land on the intent tool's ink layer and travel
into screenshots and the prompt, exactly like mouse ink. When a viewer is waiting on the
screen-capture gesture, the page shows a small **“Share screen with iPad”** button (see
[below](#why-share-screen-and-not-on-connect)).

## Fastest path: the standalone demo

One command starts everything — no overlay, no channel server, nothing else to set up:

```sh
pnpm paint:demo
```

It launches a bespoke Express server hosting the paint backend **and** a small demo app together
and prints two URLs: the demo to open on
this machine, and the LAN URL to open on your iPad. (It does **not** auto-open a browser — that path
pops a macOS "control Chrome" permission prompt; set `PAINT_DEMO_OPEN=1` if you want it back.) The
demo is a large scrollable "document" (a grid with labelled landmark blocks so scrolling is
obviously doing something):

- **draw locally** with the mouse;
- **draw from the iPad** — open the printed URL, pick *aiui paint demo*, tap **Arm**, and draw; the
  strokes land in document space, right where you drew relative to what the iPad shows;
- **navigate** with **two fingers** — drag to scroll, pinch to zoom (one finger draws, so it never
  scrolls); draw with the Apple Pencil, or one finger on a device without a pencil.
- **send video** — click **Share screen** and pick this tab. Until you do, the iPad shows
  "waiting for the desktop to start sharing" rather than a black rectangle (see below). Switch
  **JPEG ⇄ WebRTC** live with the toolbar's `video:` button (or start at `…/?video=webrtc`).

The demo lives in `packages/aiui-paint/demo/` — a compact, copyable example of wiring `InkSurface` +
`startPaintHost`.

### Why "Share screen" (and not on connect)

The demo streams the **real screen** with the default `displayCaptureSource` (`getDisplayMedia`).
That call needs two things the browser enforces: a **secure context** (`https://` or
`http://localhost` — both fine here) and, crucially, **transient user activation** — a *recent*
click. A viewer joining is a network event carrying no activation, and a *past* interaction doesn't
count (transient activation expires seconds after the gesture). So capture can't start on connect;
it has to be armed from a fresh click. The library makes that graceful rather than a silent black
screen:

- the host pre-checks `navigator.userActivation` and, if there's no activation, reports
  `videoStatus: needsGesture` to the iPad instead of firing a doomed prompt;
- the iPad shows "waiting for the desktop to start sharing" with a **Retry**, while scroll/ink keep
  working (control needs no capture);
- **Share screen** calls `host.requestCapture()` from the click — capture arms, the grant is held
  for the session, and video flows to every viewer (`videoStatus: active`).

**Escape hatch:** a host that renders its own content can skip all of this by streaming a
`canvas.captureStream()` from a custom `FrameSource` — no gesture, no picker, works from any origin.
That's strictly simpler when it applies (the host already knows how to draw its content); this demo
uses the real screen path on purpose, as a worked example of the gesture handshake.

## Run it (wire it into your own app)

**1. Host the backend.** The coordinator is host-neutral: `createPaintBackend()` returns an HTTP
handler and a websocket-upgrade handler you mount on any server you own (this is exactly what the
channel sidecar and the demo's `serve.ts` do — the demo is the copyable example):

```ts
import { createServer } from "node:http";
import express from "express";
import { createPaintBackend } from "@habemus-papadum/aiui-paint/server";

const backend = createPaintBackend({ session: { project: "my app" } });
const app = express();
app.use((req, res, next) => {
  if (!backend.handleHttp(req, res)) next();
});
const server = createServer(app);
server.on("upgrade", (req, socket, head) => {
  if (!backend.handleUpgrade(req, socket, head)) socket.destroy();
});
server.listen(8788, "0.0.0.0"); // the LAN bind is YOUR posture decision — see the warning
```

The backend serves the iPad client page at `/` (or under a `prefix` you pass), `/sessions`, and the
`/host` + `/client` websockets. Dispose it (`backend.dispose()`) on shutdown.

**2. Make a browser a host.** The desktop page has to run the host controller so it appears in the
iPad's list. If your app mounts the intent overlay **and** the channel runs the paint sidecar, this
is automatic (the overlay's `installPaintHost` probes `/paint/info` and wires the ink seam). Wiring
it by hand against your own backend:

```ts
import { startPaintHost } from "@habemus-papadum/aiui-paint";

const sink = window.__AIUI__?.remotePaint; // published by the multimodal intent tool
if (sink) {
  startPaintHost({
    relayUrl: "http://<your-mac>.local:8788", // your backend's base (path preserved if prefixed)
    ink: sink,
    label: document.title,
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

**3. On the iPad**, open the backend's URL in Safari, tap the browser you want, tap **Arm**, pick a
color and thickness, and draw. The first frame prompts the desktop once for screen-capture (auto-
accepted in the session browser). The status line shows the active video mode (`jpeg`/`webrtc`).

## Choosing the video transport

The host picks how video reaches the iPad; the iPad adapts to whichever it receives.

- **`video: "webrtc"` (default)** — the host negotiates a WebRTC peer connection per viewer (SDP +
  ICE over the relay's `signal` passthrough) and sends the capture as a real video track: smooth and
  low-latency.
- **`video: "jpeg"`** — the host samples the tab (~8 fps, downscaled) and pushes JPEG frames over
  the relay. Simple, works on any browser, and it's testable. Good enough for annotating — and it is
  the **automatic backup**: a host that can't do WebRTC (no `RTCPeerConnection`, a frame-only
  `FrameSource` with no `MediaStream`) or whose peer connection fails switches to frame streaming by
  itself; the iPad adapts to whichever arrives.

```ts
startPaintHost({
  relayUrl: "http://your-mac.local:8788",
  ink: sink,
  video: "jpeg",                                // opt out of WebRTC entirely
  // rtcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }, // if peers span subnets
});
```

On a trusted LAN the default empty `iceServers` connects on host candidates (add a STUN server only
if the two devices are on different subnets).

## Interacting from the iPad

Navigation is always available; drawing only happens while **armed**.

| Input | Armed | Not armed |
| --- | --- | --- |
| Apple Pencil (or mouse) | Draw a stroke | — |
| One finger — **no pencil in use** | Draw a stroke | — |
| One finger — **pencil in use** | ignored (palm rejection) | ignored |
| Two-finger drag | Scroll | Scroll |
| Two-finger pinch | Zoom (+ pan) | Zoom (+ pan) |

**Drawing input.** An Apple Pencil always draws. On a device without one, a single finger draws.
The client can't ask the browser "is a pencil paired?" — no API exposes that — so it infers: the
first `pointerType: "pen"` event latches "pencil mode", after which fingers only navigate and the
palm is ignored. While the pencil is actually down, all touches are dropped, so a resting palm never
marks the canvas; oversized touch contacts are also filtered as a best-effort palm guard for the
no-pencil case. **Navigation is two-finger only** — one finger never scrolls, which is what frees it
to draw.

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

- **WebRTC is the default; JPEG is the backup** — the backend carries JPEG frames or WebRTC
  signaling (the `signal` passthrough) without caring which. When a peer connection fails (or WebRTC
  isn't available at all), the host falls back to JPEG frame streaming for the room; with several
  viewers in mixed states, whoever receives frames displays frames.
- **No Bonjour discovery** — Safari web pages can't browse mDNS, so the CLI prints LAN URLs instead.
- **One trust boundary** — no auth, no encryption. The network you expose it to (or tunnel it
  over) *is* the boundary.
