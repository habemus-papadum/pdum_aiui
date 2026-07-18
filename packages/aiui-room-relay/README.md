# @habemus-papadum/aiui-room-relay

Host-neutral websocket room relay: pair a browser host with remote clients (register/join/leave/sessions/heartbeat), with message vocabulary supplied by a delegate. The shared core of aiui-pencil and aiui-remote-bar.

## Install

```sh
npm install @habemus-papadum/aiui-room-relay
```

## Usage

`createRoomRelayBackend` owns the room mechanics (register / join / leave /
sessions / heartbeat / join-replay) and returns two seams — an HTTP handler and a
websocket-upgrade handler — that a host process mounts wherever it likes. You
supply a **vocabulary delegate** for your own wire: `encode`/`decode`, what a
`register` contributes to a session, and how host/client frames route.

```ts
import { createRoomRelayBackend } from "@habemus-papadum/aiui-room-relay";

const backend = createRoomRelayBackend<MyWire>({
  prefix: "/room",
  logPrefix: "room",
  encode: (m) => JSON.stringify(m),
  decode: (text) => parseMyWire(text),
  onHostMessage: (message, { cacheForReplay }) => {
    if (message.type === "state") cacheForReplay(message); // replayed to joiners
  },
  onClientMessage: (message, { sendToHost }) => {
    if (message.type === "command") sendToHost(message);
  },
});

// mount on any Node http.Server
server.on("request", (req, res) => backend.handleHttp(req, res));
server.on("upgrade", (req, socket, head) => backend.handleUpgrade(req, socket, head));
```

The server frames the relay emits (`registered`, `sessions`, `joined`, …) are the
exported `RoomServerFrame` shapes; a consumer ties its own wire union to them with
the `Assignable` helper. **Node-only** — never import it on a browser-reachable
path. The worked consumers are `@habemus-papadum/aiui-pencil` and
`@habemus-papadum/aiui-remote-bar`.
