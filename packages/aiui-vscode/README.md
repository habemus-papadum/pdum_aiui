# @habemus-papadum/aiui-vscode

VS Code extension: a selection provider for the aiui dev overlay — pick a connected browser tab
and send editor selections into its session's turn.

A peer of the [session bus](../../docs/guide/multi-view-sessions.md): it contributes structured
`SelectionContribution` payloads on the `"contribution"` topic, and the app tab renders them as
chips and lets `composeIntent` decide how they read in the prompt at lowering time. Unlike a
browser peer it holds no websocket — it goes through the channel web backend's session HTTP
surface.

## What you get

- **A status bar item** showing the browser tab this window sends to. Click it (or run
  `aiui: Pick Browser Tab`) to choose: the picker lists every running channel server (from the
  same on-disk registry `aiui` tools use, `~/.cache/aiui/mcp/`) and the overlay tabs connected
  to each. Debug channels — the workbench's "aiui workbench" — appear too, marked `· debug`
  and sorted after real sessions; they're never auto-picked but work exactly the same once
  chosen.
- **`aiui: Send Selection to Browser Tab`** (also in the editor context menu): sends the current
  selection — verbatim text plus a 1-based `file:line:col` / `file:start-end` locator — to the
  picked tab. A quick toast confirms delivery or explains the nack (tab gone, channel gone);
  with exactly one tab running anywhere, the first send picks it automatically.

## How a selection travels

```
VS Code ──POST /session/publish {clientId, topic:"contribution", payload}──▶ channel web backend
        ◀───────────── ack {ok, delivered, armed} / nack {ok:false, error} ┘        │
                                                              SessionHub.publishFromServer
                                                                      │  /session websocket
                                                                      ▼
                                                    app tab (dev overlay) → code-selection chip,
                                                    arms the turn if it wasn't armed
```

The server acks once the message is on the tab's websocket; it reports the session's `armed`
slot alongside, but never gates on it — a contribution arms the turn on arrival (see the
overlay's contribution handler).

## Install locally

```sh
pnpm --filter @habemus-papadum/aiui-vscode build   # bundle + stage dist/extension/
pnpm --filter @habemus-papadum/aiui-vscode vsix    # pack dist/aiui-vscode.vsix
code --install-extension packages/aiui-vscode/dist/aiui-vscode.vsix
```

For a live-dev loop, skip the vsix: run **`Developer: Install Extension from Location…`** in
VS Code and point it at `packages/aiui-vscode/dist/extension/` — rebuild, then
**`Developer: Reload Window`**.

## The npm package

The published artifact is the *library* under the extension (the extension host glue is only in
the .vsix): registry discovery of running channels, the session HTTP client, and the pure
`SelectionContribution` builder — useful for any other editor tool that wants to contribute
selections to a session.

```ts
import {
  listChannels,
  fetchPeers,
  publishSelection,
  selectionToContribution,
} from "@habemus-papadum/aiui-vscode";

const [channel] = listChannels({ workspaceDir: process.cwd() });
const { peers } = await fetchPeers(channel.port);
const app = peers.find((p) => p.role === "app");
await publishSelection(channel.port, app.clientId, selectionToContribution({
  file: "src/foo.ts",
  text: "const x = 1;",
  startLine: 11, startCharacter: 4, endLine: 11, endCharacter: 16, // 0-based
}));
```
