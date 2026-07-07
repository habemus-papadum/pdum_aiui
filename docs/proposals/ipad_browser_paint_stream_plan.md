# iPad-Controlled Browser Painting Stream: Implementation Plan

This is the plan that was actually built, and how it relates to the recommended design in
[`ipad_browser_paint_stream_design.md`](./ipad_browser_paint_stream_design.md). The user guide is
[iPad Paint Stream](../guide/paint-stream.md).

## What was kept from the design proposal

The proposal's core model is sound and was adopted wholesale:

- **The desktop browser owns the model.** The iPad sends *intent*, never synthetic browser events.
- **Normalized 0..1 coordinates.** The iPad names points in the displayed content area; the desktop
  host maps them into its own surface pixels, so an intent is correct at any iPad resolution.
- **The backend is a coordinator, not the media authority.** It pairs a host with viewers and
  relays; it doesn't interpret painting.
- **A predictive local ink layer** on the iPad for immediate feedback, fading (~500 ms) as the
  authoritative view catches up over the stream.
- **Navigation is always available; painting only when armed.** Pencil draws when armed; fingers
  navigate (scroll / pinch-zoom) regardless.

## Where it diverges — and why

**Video transport: JPEG-frame streaming over a WebSocket relay, not WebRTC (for now).** The proposal
recommends WebRTC video + an `RTCDataChannel`. We start with the host sampling the tab via
`getDisplayMedia` into downscaled JPEG frames pushed over the same WebSocket that carries control.
Reasons specific to this codebase:

- It **reuses machinery that already exists here** — the overlay's shot tool already does
  `getDisplayMedia({ preferCurrentTab })` and JPEG frame encoding.
- It is **testable in Node**: the relay just moves bytes, so the whole pairing/relay/broadcast path
  has real unit tests. WebRTC is effectively untestable headless and is a large amount of ICE/SDP
  code before the first pixel.
- The user explicitly said latency and scroll fidelity are **not critical** ("even the scrolling
  doesn't have to be high fidelity").

The divergence is deliberately **non-lossy for the future**: the wire protocol keeps an opaque
`signal` passthrough that the relay forwards untouched in both directions, so WebRTC (video track +
data channel, negotiated peer-to-peer) can be layered on **without changing the relay** — the
control protocol and the host's coordinate mapping stay identical. The frame path becomes a fallback.

**Control transport: the WebSocket relay, not a peer `RTCDataChannel`.** Same rationale — it is
reliable, ordered, trivially testable, and correct on a trusted LAN. This is the part that matters
most (ink landing in the overlay), so it gets the boring, verifiable transport.

**The iPad *does* choose color and thickness.** The proposal keeps all brush authority on the
desktop and has the iPad send geometry only. The user wanted the iPad to pick color and line
thickness, so a stroke carries a small `{ color, width }` style on the wire; the host applies it.

## Packages

The reusable pieces were split out, per the user's request ("move the ink drawing stuff into its own
package… the coordination of the server into its own package"):

- **`@habemus-papadum/aiui-ink`** — a framework-free canvas ink surface. Local pointer inking **or**
  a remote stroke feed, per-stroke color + width, optional fade, screenshot compositing. This is the
  reusable "ink component" — usable on its own (e.g. handwriting math) independent of the paint
  stream. Graduated from the overlay's internal `Ink`.
- **`@habemus-papadum/aiui-paint`** — the coordination layer: the wire protocol, the LAN relay
  server, the desktop host controller, the iPad client (served by the relay), and a CLI. Depends on
  `aiui-ink` for the standalone host path.

## Security posture

The relay binds the **LAN (`0.0.0.0`) and is unauthenticated** — matching the user's "full trust
boundary, not meant to be secure" framing, and consistent with the repo's habit of documenting its
posture loudly rather than hiding it. Crucially it is a **separate process** from the loopback-only
channel MCP server, whose `127.0.0.1` posture is **unchanged**. The CLI prints the warning on every
launch; the guide repeats it.

## Integration with the intent tool

Remote ink lands in the **same** ink layer the intent tool uses, so a shape drawn on the iPad
composites into a screenshot and becomes part of the intent turn exactly like a locally drawn one.
The seam is a small `RemotePaintSink` object the overlay publishes at `window.__AIUI__.remotePaint`
when the multimodal modality mounts; `aiui-paint`'s host consumes it structurally (its `InkSink`), so
neither package imports the other.

## Discovery

The proposal's "list of browsers and their session info" is served by the relay's `/sessions`: every
browser that connects as a host is a session. Because the relay and the channel servers live on the
same machine, a host that reports its channel port (`window.__AIUI__.port`) is enriched from the
on-disk channel registry with the agent session's tag and project directory — so the iPad list shows
which agent session each browser belongs to, without the browser needing registry access.

Bonjour/mDNS discovery (a proposal "nice to have") was **not** attempted: Safari web pages can't
browse Bonjour, so it would require a native app. The CLI instead prints the LAN URLs to open.

## Status

Built and tested: the ink surface, the protocol + codec, the relay (pairing, intent relay, video
broadcast, session enrichment, HTTP serving), the host's intent-application core and sink adapters,
and the overlay's remote-ink path. The browser-only wiring (websocket + screen capture on the host,
the iPad client's gestures) is exercised by hand and via the guide's walkthrough. WebRTC video and
Bonjour are documented seams, not yet implemented.
