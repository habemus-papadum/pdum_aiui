# The Browser Extension

The **intent client** is aiui's frontend for the prompt-lowering pipeline — the surface where
ink, keys, screen capture, and dictation on a live page become a turn in the running Claude Code
session. It runs as one shared core across a few hosts; this page is about the **MV3 browser
extension** (the side panel, `dist-ext`) — the one extension `aiui claude` auto-loads.

For the other host (the channel-served plain page at `/intent/`, which drives real tabs over CDP)
and the capture/transport runtime that backs both, see the package overview:
[`@habemus-papadum/aiui-intent-client`](/packages/aiui-intent-client/).

::: warning 🚧 This page is a stub
The browser extension deserves a real guide and does not have one yet. The sections below are
placeholders: the behavior they name is real — it's the decided contract in the package's
`BEHAVIOR.md` and `PARITY.md` — but the prose here still needs to be written.
**[Installing](#installing) at the bottom is complete and current** — that part you can rely on
today.
:::

## What it is

_TODO._ The side panel, its warm `tabCapture` video, how it discovers the channel, and how it
shares one mode engine with the plain-page host.

## Activating a tab

_TODO._ The `Cmd/Ctrl+B` chord both opens the panel and **invokes** the tab, which is what grants
`tabCapture` standing — it is not merely a shortcut. What happens when the chord is already claimed
by another extension.

## The modes

_TODO._ Ink, keys, capture, dictation, and VS Code jump — the mode engine and the contract it shares
with the plain-page host. (Jump mode is described today under
[VS Code Integration](./vscode#from-the-page-back-to-the-editor-vs-code-jump-mode).)

## Capture & dictation

_TODO._ The shot path (an invocation-gated stream id minted by the service worker and consumed by
the panel), the mic worklet, and how frames and audio reach the
[lowering pipeline](./prompt-lowering).

## Installing

### It's already loaded in the session browser

With the browser attached (the default), `aiui claude` loads the extension into the shared
**session browser** for you, over CDP — there is nothing to install. Press `Cmd/Ctrl+B` on any tab
to arm a turn and open the panel. This is the primary path; the download below is only for running
the panel in your **everyday** Chrome.

### Install a release build in your own Chrome

Chrome has no zero-friction off-store install — a raw `.crx` won't install unless it comes from the
Web Store — so a release build is loaded **unpacked**:

1. Download `aiui-chrome-<version>.zip` from the
   [latest GitHub release](https://github.com/habemus-papadum/pdum_aiui/releases/latest).
2. Unzip it — you get an `aiui-chrome-<version>/` folder with `manifest.json` at its root.
3. Open `chrome://extensions`, turn on **Developer mode** (top-right), click **Load unpacked**, and
   select that folder.
4. Press `Cmd/Ctrl+B` on a tab to open the panel. If the shortcut didn't bind — another extension
   already claimed it — set it at `chrome://extensions/shortcuts`.

The extension id is fixed (`cdpbfpcelmifhagikjlfpgfipggcmdeg`), so it's stable across reloads and
machines. Developer-mode extensions don't auto-update; reinstall from a newer release to upgrade.
(A one-click, auto-updating Chrome Web Store listing is a possible future — it isn't set up yet.)
