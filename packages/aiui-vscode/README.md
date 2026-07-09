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
  to each. Debug channels (standalone `serve` servers) appear too, marked `· debug`
  and sorted after real sessions; they're never auto-picked but work exactly the same once
  chosen.
- **`aiui: Send Selection to Browser Tab`** (also in the editor context menu): sends the current
  selection — verbatim text plus a 1-based `file:line:col` / `file:start-end` locator — to the
  picked tab. A quick toast confirms delivery or explains the nack (tab gone, channel gone);
  with exactly one tab running anywhere, the first send picks it automatically.
- **`aiui: Refresh Browser Tabs`**: revalidates the remembered tab and repaints the status bar.
  Mostly unnecessary — the picker re-queries the registry and each channel's live peers every
  time it opens, and every send revalidates first — but handy when you just want the status bar
  to catch up.

Channels are titled by their **Claude Code session name** where possible: a channel's `ppid` is
the session that spawned it, matched via `claude agents --json` exactly like the CLI selector
(falls back to the channel's registry name or its tag when `claude` isn't
on the extension host's PATH).

**Staleness is expected and handled**: a channel reload (source edit under watch, or
`POST /debug/api/reload`) drops every websocket, and the overlay tab reconnects with a **new
clientId**. Sends revalidate against live peers first and silently re-bind to the same tab (by
id, then URL, then "it's the only tab"), so a reload doesn't cost you a re-pick — you only hear
about it when the tab or channel is genuinely gone.

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

## The other direction: the overlay's VS Code mode

The dev overlay closes the loop back into this editor: with the intent tool armed, **J** enters
**VS Code jump mode** — a tweak-style handover (dashed blue ring) where **double-clicking** an
element opens the **jump picker**: the stamped element ancestors of the click point
(`data-source-loc`, nearest preselected) plus the containing cells at their *definition* sites
(`data-cell-loc`, the `cell(...)` call). Arrows/digits/Enter pick a row — the selected row's
bounding box lights up on the page — and committing opens VS Code there, via a `vscode://file/…`
URL computed on the fly from the same DOM attribution contract this extension's selections ride
in on. A click with nothing to open is named in the picker ("no source location on or around
this element"), never a silent no-op, and the mode ends itself when the jump blurs the window,
so returning to the tab resumes composing. Details in
[Using the Intent Overlay](../../docs/guide/intent-overlay.md) and
[VS Code Integration](../../docs/guide/vscode.md).

## Install locally

From the repo root, either flavor:

```sh
pnpm vscode:install   # pack dist/aiui-vscode.vsix and `code --install-extension` it
pnpm vscode:link      # symlink dist/extension/ into ~/.vscode/extensions (live-dev)
```

then reload the VS Code window. `vscode:install` gives you a normal installed extension
(reinstall to update). `vscode:link` is the live-dev loop: the staged folder is symlinked, so
after any rebuild (`pnpm --filter @habemus-papadum/aiui-vscode build`) a window reload picks up
the changes — no repackaging. Don't keep both installed at once. The same scripts exist on the
package as `install:vsix` / `install:dir`, and the plain `vsix` script packs without
installing; `Developer: Install Extension from Location…` pointed at
`packages/aiui-vscode/dist/extension/` remains the manual equivalent of `vscode:link`.

## Remote windows (SSH / WSL / containers)

The extension is a **workspace extension** (`"extensionKind": ["workspace"]`): everything it
touches — the channel registry, each channel's loopback port, the `claude` CLI — lives where
`aiui claude` runs, so in a remote window it runs in the remote extension host, next to the
session, and none of the discovery changes. Install it **on the remote box**: run either
command above from a checkout there, inside the remote window's integrated terminal — the
`code` shim in a remote terminal installs into the remote server, and `vscode:link` links into
`~/.vscode-server/extensions/` as well as `~/.vscode/extensions/` when the host is a VS Code
remote. Selection chips deep-link back through `vscode://vscode-remote/…` (instead of
`vscode://file/…`), so clicking one in your local browser reopens the file in the remote
workspace. The rest of the remote story — session browser tunnel, port forwards — is
[Remote Development](../../docs/guide/remote.md).

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
