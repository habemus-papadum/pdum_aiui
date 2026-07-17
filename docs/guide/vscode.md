# VS Code Integration

VS Code and an aiui session meet in two directions:

- **Editor → turn** — the **aiui VS Code extension** (`@habemus-papadum/aiui-vscode`) sends
  editor selections into the running session's turn: pick a connected browser tab once, then
  fire code at it from the editor's context menu.
- **Page → editor** — the intent client's **VS Code jump mode** jumps the other way:
  double-click anything the app renders and VS Code opens at the source that drew it.

Together they close the loop: the file you jump to from the page is the same editor window that
contributes selections back into the turn.

## The extension

Installing it gives every VS Code window:

- **A status bar item** showing which browser tab this window sends selections to. Click it (or
  run `aiui: Pick Browser Tab`) to choose — the picker lists every running channel server (from
  the same on-disk registry the `aiui` tools use) and the overlay tabs connected to each,
  titled by their Claude Code session names where possible. Debug channels appear too, marked
  `· debug`, never auto-picked.
- **`aiui: Send Selection to Browser Tab`** (also in the editor context menu): sends the
  current selection — verbatim text plus a 1-based `file:line:col` locator — to the picked tab.
  It arrives as a **code chip** in the overlay's turn preview (arming the turn if needed), and
  the lowering decides how it reads in the final prompt. A toast confirms delivery or explains
  the nack.
- **`aiui: Refresh Browser Tabs`**: revalidates the remembered tab and repaints the status bar.
  Mostly unnecessary — the picker re-queries on every open, and every send revalidates first.

Staleness is handled: a channel reload hands the tab a new client id, and sends silently
re-bind to the same tab (by id, then URL, then "it's the only tab") — you only hear about it
when the tab or channel is genuinely gone.

### Install

From the repo root, either flavor, then reload the VS Code window:

```sh
pnpm vscode:install   # pack the .vsix and `code --install-extension` it
pnpm vscode:link      # symlink the staged extension (live-dev: rebuild + reload)
```

The extension is not on the marketplace (yet); the npm package ships the underlying library
(channel discovery, the session HTTP client, the contribution builder) for other editor tools.

### Remote windows (SSH / WSL / containers)

The extension is a **workspace extension** (`"extensionKind": ["workspace"]`): everything it
touches — the channel registry, each channel's loopback port, the `claude` CLI — lives where
`aiui claude` runs, so in a remote window it runs in the remote extension host, next to the
session. Install it **on the remote box** (run the commands above from the remote window's
integrated terminal; `vscode:link` links into `~/.vscode-server/extensions/` there). Selection
chips deep-link back through `vscode://vscode-remote/…` instead of `vscode://file/…`, so
clicking one in your local browser reopens the file in the remote workspace. The rest of the
remote story is [Remote Development](./remote).

## From the page back to the editor: VS Code jump mode

The intent client's **J** key enters VS Code jump mode — a tweak-shaped handover (dashed
**blue** ring) where the page keeps the pointer and keyboard, and the client claims exactly one
gesture: **double-click**, which opens the **jump picker** — a popup listing everything the
click point can jump to. Two groups: the stamped **element** ancestors (`data-source-loc`,
nearest → outermost, nearest preselected) and the containing **cells** (`data-cell`), each at
the cell's *definition* site — the `cell(...)` call (`data-cell-loc`), not the JSX that renders
it. **↑/↓** move (the selected row's bounding box lights up on the page), **1–9** or **Enter**
commit, **Esc** dismisses; committing opens VS Code at that `file:line`.

The `vscode://file/…` URL is **computed on the fly** from the row's stamp and the dev server's
source root — the same annotations screenshots and selections attribute with (see
[Frontend for Agents](./frontend-for-agents)). Misses are always **named** — an unstamped click
opens a picker that says "no source location on or around this element"; a cell with no
recorded definition shows grayed — a jump never silently does nothing. The full interaction is
named — a jump never silently does nothing.

Because a jump takes you out of the browser, the mode **ends itself when the window blurs**:
coming back to the tab resumes composing rather than leaving a double-click trap armed. An open
turn survives the excursion — thread and socket stay open, the idle timer is suspended — so
"double-click the broken widget, glance at its source, come back and finish the sentence" is
one turn, not three.

**Remote caveat:** the stamps resolve against the machine running the dev server. In a remote
setup the `vscode://file/…` link carries a remote path, which your local VS Code won't have —
use the extension's selection flow (which deep-links via `vscode://vscode-remote/…`) or open
the file from the locator the turn carries.

## How a selection travels

```
VS Code ──POST /session/publish {clientId, topic:"contribution", payload}──▶ channel web backend
        ◀───────────── ack {ok, delivered, armed} / nack {ok:false, error} ┘        │
                                                                     /session websocket
                                                                              ▼
                                                       app tab (dev overlay) → code-selection
                                                       chip, arms the turn if it wasn't armed
```

The extension holds no websocket — it goes through the channel web backend's session HTTP
surface (a peer of the `/session` bus — see [the channel](./channel)). The payload stays structured
(verbatim text + locator); rendering is deferred to `composeIntent` at lowering time, like
every other contribution.
