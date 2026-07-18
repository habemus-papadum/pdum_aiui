# Getting Started with @habemus-papadum/aiui-room-relay

> This page lives at `packages/aiui-room-relay/docs/getting-started.md`. It's picked up automatically by the
> docs site as a guide under this package — edit or delete it, and add more `*.md` files here for
> additional per-package guides. The package overview comes from the `README.md`; the API
> reference is generated from `src/index.ts`.

Host-neutral websocket room relay: pair a browser host with remote clients (register/join/leave/sessions/heartbeat), with message vocabulary supplied by a delegate. The shared core of aiui-pencil and aiui-remote-bar.

## Install

```sh
npm install @habemus-papadum/aiui-room-relay
```

## Usage

`createRoomRelayBackend` owns the message-agnostic room mechanics and returns two
seams — `handleHttp` and `handleUpgrade` — that a host process mounts on any Node
server. Everything wire-specific lives in the **vocabulary delegate** you pass:
`encode`/`decode`, `registerExtras` (what a `register` adds to a session),
`joinedExtras`, and the `onHostMessage`/`onClientMessage` routers.

```ts
import { createRoomRelayBackend } from "@habemus-papadum/aiui-room-relay";

const backend = createRoomRelayBackend<MyWire>({
  prefix: "/room",
  logPrefix: "room",
  encode: (m) => JSON.stringify(m),
  decode: (text) => parseMyWire(text),
  onHostMessage: (message, { cacheForReplay }) => {
    if (message.type === "state") cacheForReplay(message); // replayed on join
  },
  onClientMessage: (message, { sendToHost }) => {
    if (message.type === "command") sendToHost(message);
  },
});
```

**Node-only** (`ws` + `node:http`/`node:stream`): keep it off any
browser-reachable import path. The two worked consumers are
`@habemus-papadum/aiui-pencil` (ink + WebRTC signaling) and
`@habemus-papadum/aiui-remote-bar` (a mode engine projected as a command bar).
