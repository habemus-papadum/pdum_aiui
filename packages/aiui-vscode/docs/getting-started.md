# Getting Started with @habemus-papadum/aiui-vscode

The VS Code selection provider for the aiui dev overlay: a status bar item that shows (and
picks) the browser tab this window talks to, and a command that sends the current editor
selection into that tab's session turn.

## Install the extension

If you have `aiui` installed, the one-liner pulls the `.vsix` from this repo's matching GitHub
release and installs it (it is not on the marketplace):

```sh
aiui vscode install                 # this aiui build's release
aiui vscode install --tag latest    # the newest release, whatever your aiui version
aiui vscode install --editor cursor # install into a different editor CLI
```

Or build and install it locally from a source checkout (also what you want for an unreleased
working tree):

```sh
pnpm --filter @habemus-papadum/aiui-vscode build
pnpm --filter @habemus-papadum/aiui-vscode vsix
code --install-extension packages/aiui-vscode/dist/aiui-vscode.vsix
```

Working over VS Code Remote (SSH / WSL / containers)? The extension is a workspace extension —
it runs on, and must be installed on, the remote host, where `aiui claude`, the channel
registry, and the channels' loopback ports live. Run the same commands from the remote window's
integrated terminal (the `code` CLI there installs into the remote server), or use
`pnpm vscode:link` on the remote box for the live-dev symlink install.

## Use it

1. Launch a session with `aiui claude` and open your app with the dev overlay mounted.
2. In VS Code, click the **aiui** status bar item and pick the browser tab (channels come from
   the on-disk registry; tabs from each channel's `GET /session/peers`).
3. Select code, then run **`aiui: Send Selection to Browser Tab`** (command palette or editor
   context menu). A toast confirms delivery — the selection appears as a chip in the overlay's
   turn preview, arming the turn if needed — or explains why nothing was delivered.

## Jumping back the other way

The dev overlay pairs a return path with this extension: arm the overlay, press **J** for
VS Code jump mode, and **double-click** any element — a picker pops up listing the stamped
element ancestors and the containing cells (at their `cell(...)` definition sites); pick a row
(↑↓/1–9/Enter, the row's bounding box highlights on the page) and VS Code opens there. The
`vscode://` link is computed on the fly from the `data-source-loc` / `data-cell-loc` stamps; a
click with nothing to open says "no source location" in the picker, and the mode ends itself
when the jump takes focus away, so the tab comes back composing.

## How it plugs in

The extension POSTs a structured `SelectionContribution` to the channel web backend's
`POST /session/publish`, targeted at the picked tab's `clientId`; the server relays it down the
tab's `/session` websocket on the `"contribution"` topic (`from: "server"`), exactly the message
a browser-side contributor publishes from its own socket. Formatting is deferred to lowering: the payload
carries verbatim text plus a `file:line:col` locator, and `composeIntent` decides how it reads
in the final prompt.
