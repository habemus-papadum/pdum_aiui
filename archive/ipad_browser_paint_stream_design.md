# iPad-Controlled Browser Painting Stream: Recommended Design

## Recommendation

Build this as an **app-specific WebRTC streaming and control system**:

- **WebRTC video** streams the live browser/app view from the desktop host to the iPad.
- **RTCDataChannel events** send interaction data from the iPad back to the desktop app.
- The **desktop app applies those events directly to its own model** instead of trying to simulate generic browser input.
- The iPad renders a short-lived **predictive local stroke** while the authoritative stroke is applied by the desktop app and returns through the video stream.
- Navigation gestures such as scroll, pan, and zoom are always available, whether or not painting is armed.

This keeps the system simple, low-latency where it matters, and avoids the complexity of trying to remote-control an arbitrary browser tab. Because the target app owns the model, the iPad does not need to synthesize mouse events or guess browser behavior. It just sends intent: stroke points, navigation deltas, zoom gestures, and mode state.

## Core Product Model

The iPad is a live remote surface for a desktop browser-based painting app.

The user sees a real-time video stream of the desktop app on the iPad. On top of that video, the iPad has a transparent input layer that captures Pencil, touch, and gesture input. The iPad does not own the document state. The desktop app remains authoritative.

There are two broad classes of input:

1. **Navigation input**
   - Scroll vertically.
   - Scroll horizontally.
   - Pan the viewport or canvas.
   - Zoom in and out.
   - Navigation should always be available.

2. **Painting input**
   - Pencil or finger strokes.
   - Painting only happens when the client is **armed**.
   - When not armed, drawing gestures should not modify the painting model.

The system is intentionally not a general-purpose remote desktop tool. It is an app-specific remote interaction layer for a known browser application.

## High-Level Architecture

```text
                 Shared backend / signaling server
                  - authentication
                  - room creation
                  - WebRTC signaling
                  - session coordination
                              │
             ┌────────────────┴────────────────┐
             │                                 │
      Desktop browser app                 iPad web client
      - owns painting model               - fullscreen video view
      - captures live view                - transparent input layer
      - sends WebRTC video                - local predictive ink
      - receives data events              - sends gestures/events
      - renders authoritative ink
             │                                 │
             └────── WebRTC media + data ──────┘
```

The backend should coordinate the connection but should not be in the media path for the minimal implementation. Once the two clients have paired and exchanged WebRTC signaling information, video and control events flow directly over the peer connection.

## Components

### 1. Desktop Host App

The desktop browser app is the source of truth.

Responsibilities:

- Capture or render the live app view for WebRTC video streaming.
- Maintain the authoritative painting/document model.
- Receive input events from the iPad over an RTCDataChannel.
- Apply paint strokes to the model when painting is armed.
- Apply navigation gestures regardless of painting mode.
- Send current mode and view metadata to the iPad.

The desktop app should treat remote iPad input as just another app input source, not as simulated browser events.

### 2. iPad Client

The iPad client can be a fullscreen web app.

Responsibilities:

- Join a paired session through the backend.
- Receive and display the WebRTC video stream.
- Capture Pencil, touch, and gesture input through a transparent overlay.
- Send normalized event data back to the desktop app.
- Draw predictive local strokes immediately for low perceived latency.
- Fade or remove predictive strokes once the authoritative video catches up.

The iPad client should not need to know the current brush color, brush texture, blend mode, or document model details. Those belong to the desktop app. The iPad only sends geometry and input information.

### 3. Shared Backend

The backend is a coordinator.

Responsibilities:

- Create a short-lived session or room.
- Authenticate both desktop and iPad clients.
- Relay WebRTC offer/answer and ICE candidates.
- Optionally expose session state such as connected/disconnected status.
- Optionally help with device pairing through QR codes or short codes.

The backend does not need to interpret painting events in the minimal version.

## Connection Flow

A minimal connection flow:

```text
1. Desktop app opens a host session.
2. Backend creates a session ID and pairing token.
3. Desktop displays a QR code or pairing URL.
4. iPad opens the paired client URL.
5. Both clients connect to the backend signaling channel.
6. Desktop creates a WebRTC peer connection.
7. Desktop adds the live video track.
8. Desktop creates one or more RTCDataChannels for control/input.
9. Backend relays SDP offer/answer and ICE candidates.
10. iPad receives the video stream and displays it fullscreen.
11. iPad input overlay begins sending navigation and paint events.
12. Desktop applies those events to the app model.
13. Updated authoritative state appears back on the iPad through the video stream.
```

## Interaction Modes

The system should have a simple **armed** state.

```text
armed = true   → Pencil/finger drawing creates paint strokes.
armed = false  → Pencil/finger drawing does not create paint strokes.
```

Navigation is separate from the armed state.

```text
Navigation gestures are always allowed.
Painting gestures only modify the model while armed.
```

This separation is important because users should be able to move around the document without constantly toggling out of paint mode.

A practical input policy:

| Input | Armed | Not Armed |
|---|---:|---:|
| Pencil stroke | Paint | No paint / optional cursor preview |
| One-finger drag | App-defined: paint or pan | Pan / navigate |
| Two-finger drag | Pan / scroll | Pan / scroll |
| Pinch | Zoom | Zoom |
| Wheel/trackpad gesture, if available | Scroll / zoom | Scroll / zoom |

The exact gesture mapping can be tuned, but the key rule is that navigation should remain globally available.

## Predictive Stroke Layer

Painting has one latency-sensitive affordance: local predictive ink.

When the user draws on the iPad while armed:

1. The iPad immediately draws the stroke on a local overlay canvas.
2. The iPad sends stroke points to the desktop app over the data channel.
3. The desktop app applies the stroke to the authoritative model using the current app brush settings.
4. The desktop-rendered result appears in the WebRTC video stream.
5. The iPad fades or removes the predictive stroke.

A good initial behavior:

```text
predictiveStrokeFadeMs = 500
```

The predictive stroke does not need to exactly match the final rendering. Its job is to give immediate visual feedback. The final color, brush, smoothing, blend mode, and document modification all happen on the desktop app.

This means the iPad does **not** need to receive or understand the current color. At most, it can use a neutral preview color or a lightweight hint provided by the app. The authoritative stroke is whatever the desktop app renders.

## Data Channels

Use WebRTC data channels for input and control events.

A simple version can use one data channel:

```text
input-control
```

For a slightly better version, use two:

```text
control  → reliable, ordered messages
pointer  → low-latency, droppable movement samples
```

Suggested split:

- **control channel**
  - armed state changes
  - session metadata
  - stroke begin/end/cancel
  - viewport metadata
  - acknowledgments, if needed

- **pointer channel**
  - high-frequency pointer move samples
  - stroke point batches
  - navigation deltas

For the minimal implementation, one ordered channel is acceptable. If move events start queueing and feel stale, split high-frequency movement onto a lossy/unordered channel.

## Coordinate System

The iPad should send normalized coordinates rather than raw pixels.

```json
{
  "u": 0.421,
  "v": 0.736
}
```

Where:

```text
u = horizontal position within the displayed video/content area, from 0 to 1
v = vertical position within the displayed video/content area, from 0 to 1
```

The desktop app maps these values into its own viewport, canvas, or document coordinates.

This avoids hard-coding iPad screen resolution, browser zoom, device pixel ratio, or video scaling behavior into the event protocol.

The desktop app should periodically send view metadata to the iPad:

```json
{
  "type": "viewState",
  "viewportWidth": 1440,
  "viewportHeight": 900,
  "documentZoom": 1.25,
  "scrollX": 120,
  "scrollY": 800
}
```

The iPad can use this for better gesture interpretation, overlays, cursor display, and debugging, but the desktop app should remain responsible for final coordinate mapping.

## Suggested Event Protocol

Keep the protocol small and app-specific.

### Armed State

```json
{
  "type": "setArmed",
  "armed": true
}
```

### Stroke Begin

```json
{
  "type": "strokeBegin",
  "strokeId": "stroke-123",
  "pointerType": "pen",
  "u": 0.35,
  "v": 0.62,
  "pressure": 0.41,
  "time": 123456.7
}
```

### Stroke Points

Batch move points to reduce overhead:

```json
{
  "type": "strokePoints",
  "strokeId": "stroke-123",
  "points": [
    { "u": 0.351, "v": 0.621, "pressure": 0.42, "time": 123457.1 },
    { "u": 0.353, "v": 0.623, "pressure": 0.43, "time": 123457.5 }
  ]
}
```

### Stroke End

```json
{
  "type": "strokeEnd",
  "strokeId": "stroke-123",
  "u": 0.41,
  "v": 0.68,
  "pressure": 0,
  "time": 123480.2
}
```

### Stroke Cancel

```json
{
  "type": "strokeCancel",
  "strokeId": "stroke-123"
}
```

### Scroll / Pan

```json
{
  "type": "scroll",
  "dx": 0,
  "dy": 540,
  "unit": "cssPx"
}
```

### Zoom

```json
{
  "type": "zoom",
  "centerU": 0.5,
  "centerV": 0.5,
  "scale": 1.08
}
```

### View State From Desktop to iPad

```json
{
  "type": "viewState",
  "armed": true,
  "viewportWidth": 1440,
  "viewportHeight": 900,
  "documentZoom": 1.25,
  "scrollX": 120,
  "scrollY": 800
}
```

## Event Semantics

The event protocol should describe **intent**, not browser mechanics.

Good:

```json
{ "type": "strokePoints", "strokeId": "s1", "points": [...] }
```

Good:

```json
{ "type": "zoom", "centerU": 0.5, "centerV": 0.5, "scale": 1.05 }
```

Avoid:

```json
{ "type": "syntheticMouseMove", "clientX": 550, "clientY": 410 }
```

The desktop app should decide how those intents map onto its model and viewport. That keeps the system stable even if the desktop UI changes.

## Rendering Model

There are two visual layers on the iPad:

```text
1. WebRTC video layer
   - authoritative app view
   - includes committed strokes
   - comes from desktop

2. Local overlay layer
   - predictive strokes
   - optional cursor / touch feedback
   - fades quickly
   - never authoritative
```

The predictive layer should be visually lightweight. It should avoid becoming a second source of truth.

Suggested behavior:

```text
On strokeBegin:
  create local predictive stroke
  send strokeBegin

On strokePoints:
  append to local predictive stroke
  send batched strokePoints

On strokeEnd:
  finish local predictive stroke
  send strokeEnd
  begin fade-out timer

After predictiveStrokeFadeMs:
  remove local predictive stroke
```

The fade can be tuned. Start with 500 ms. If the video stream usually catches up faster, reduce it. If users see gaps, increase it slightly.

## Navigation Model

Navigation should be handled by the app model, not by remote browser input.

Examples:

```text
Two-finger drag on iPad
  → send pan/scroll delta
  → desktop app updates viewport/canvas transform
  → updated view appears in video

Pinch on iPad
  → send zoom scale and center point
  → desktop app updates zoom around that point
  → updated view appears in video
```

Because navigation is always allowed, gesture recognition needs to distinguish navigation from painting.

A good starting policy:

```text
Pencil input while armed:
  paint

Pencil input while not armed:
  no paint, optional hover/cursor/preview

One-finger touch:
  app-defined, but probably pan or interact

Two-finger touch:
  pan/scroll

Pinch:
  zoom
```

## Minimal Implementation Plan

### Phase 1: WebRTC View

Build the basic paired session.

- Desktop creates a session.
- iPad joins by URL or QR code.
- Backend relays WebRTC signaling.
- Desktop streams the app view to the iPad.
- iPad displays the stream fullscreen.

Success condition:

```text
The iPad can see a live view of the desktop app.
```

### Phase 2: Data Channel and Navigation

Add an input data channel.

- iPad captures gesture input.
- iPad sends scroll/pan events.
- iPad sends zoom events.
- Desktop app applies navigation to its own viewport.

Success condition:

```text
The iPad can navigate the desktop app view.
```

### Phase 3: Armed Painting

Add the armed state and remote painting events.

- Desktop app exposes armed state.
- iPad sends stroke events only when armed.
- Desktop app applies strokes to the painting model.
- The resulting stroke appears in the returned video stream.

Success condition:

```text
The iPad can draw into the desktop app model.
```

### Phase 4: Predictive Local Ink

Add the latency affordance.

- iPad draws local predictive strokes immediately.
- Predictive strokes fade after a configurable interval.
- Authoritative strokes remain visible through video.

Success condition:

```text
Drawing feels immediate even though the authoritative result arrives through video.
```

### Phase 5: Refinement

Improve feel and robustness.

- Batch pointer points efficiently.
- Use pressure and tilt if available.
- Tune predictive fade duration.
- Add reconnect handling.
- Add explicit connection status.
- Add debugging overlay for latency and coordinate mapping.

## Important Defaults

Recommended initial defaults:

```text
Video transport: WebRTC
Input transport: RTCDataChannel
Backend role: signaling and session coordination only
Painting authority: desktop app model
Predictive ink owner: iPad overlay
Predictive fade: 500 ms
Coordinates: normalized 0..1 video/content coordinates
Navigation: always enabled
Painting: enabled only when armed
Brush/color authority: desktop app
```

## Non-Goals

This design intentionally does not try to solve:

- Generic remote desktop control.
- Arbitrary browser tab input injection.
- OS-level mouse or keyboard simulation.
- Full-fidelity local rendering of the painting engine on the iPad.
- Server-side video relay or media mixing.
- Shared multi-user editing semantics.

Those can be added later if needed, but they are not required for the core app-specific interaction loop.

## Summary

The simplest strong design is:

```text
iPad captures intent
  → sends app-specific events over RTCDataChannel
  → desktop app updates its authoritative model
  → desktop app streams the updated view back over WebRTC
  → iPad overlays short-lived predictive ink for responsiveness
```

This gives the iPad a responsive drawing feel while keeping the document state, brush logic, color, navigation model, and rendering authority inside the desktop app.
