# @habemus-papadum/aiui-pencil

A pencil: pressure/tilt/azimuth-driven textured strokes, erasing, and vanishing ink, on a
three-tier raster surface — plus the whole **remote pencil**: the relay backend/sidecar, the
host and client sessions (WebRTC video + ink intent), and the iPad client app.

## Install

```sh
npm install @habemus-papadum/aiui-pencil
```

## The entries

| Subpath | What it is |
| ------- | --- |
| `.` | the instrument (`PencilSurface`, params/presets, telemetry, splines, dabs, grain) and the session layer (`HostSession`, `ClientSession`, the wire protocol) |
| `./client` | the **remote client kit** (Solid): `PencilRemoteApp` and the pieces it composes |
| `./server` | the relay backend (`createPencilBackend`) |
| `./sidecar` | the channel sidecar (`pencilSidecar`) — serves the client app at `/pencil/` and relays `/pencil/host` ↔ `/pencil/client` |

## The remote client: one app, per-application presentation

There is ONE served client app (`client/`, built to `assets/client`, served by the sidecar at
`GET /pencil/`) — and two ways to customize it (owner, 2026-07-17):

- **The paved road**: a host declares a `RemotePresentation` when it registers —
  `{ title, accent, tools, modes, undo, clear, navigation, color, size }` — and the shared app
  renders from it: which tools and presets the strip offers, whether the brush color/size knobs
  exist, whether two-finger gestures emit scroll/zoom intents. Absent fields default to
  fully-featured (the Lab). The intent client, for example, registers
  `{ tools: ["draw"], modes: ["write"], color: false, size: false }` — a markup surface, not a
  paint studio.
- **Full control**: compose your own page from the kit — `RemoteView` (the display: video,
  letterbox plane, preview crossfade — all the coordinate correctness that must never be
  rebuilt), `SessionPicker`, `PencilStrip`, `bindPenInput`, `createPlaneTracker`.

Presentation is presentation: the host stays authoritative. Brush-knob choices ride each
`strokeBegin` as `overrides` and the **host** merges them over its own resolved preset (and can
clamp outright — the intent client forces `draw` + the write preset host-side).

## Hosting a session

```ts
import { HostSession } from "@habemus-papadum/aiui-pencil";

const session = new HostSession({
  url: hostRelayUrl(),           // ws://…/pencil/host
  label: "my app",
  presentation: { tools: ["draw"], color: false, size: false },
  surface: () => pencilSurface,  // where remote strokes land
  size: () => plane,             // MUST equal the captured frame (see host-session.ts)
  stream: () => captureStream,
});
session.connect();
```

`aiui pencil url` prints where an iPad should point its browser, per running channel.

## Developing

- `pnpm lab` — the Lab rig (the reference host; serves the built client at `/pencil/`).
- `pnpm dev:client` — HMR loop on the client app alone.
- `pnpm build:client` — the servable artifact (`assets/client`), what ships.
