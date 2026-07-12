# @habemus-papadum/aiui-extension

The aiui intent tool as a Chrome MV3 extension: per-window side panel (the tool's whole visible
surface), channel binding, capture, ink, page tools. Design:
`docs/proposals/browser-extension-intent-tool.md`; measured groundwork:
`archive/extension-spikes/RESULTS.md`. Built on
[`@habemus-papadum/aiui-webext`](../aiui-webext/README.md).

> **Picking this work up fresh?** Read [`docs/CONTINUITY.md`](./docs/CONTINUITY.md) first — status,
> working agreements, the traps that already cost cycles, and the ordered plan for what's next.

## Two artifacts, two directories

This is the single most important fact about working here:

| command | writes | what it is |
|---|---|---|
| `vite` (dev) | **`dist-dev/`** | CRXJS loader stubs — **inert without the dev server** on :5317 |
| `vite build` | **`dist/`** | the standalone extension; needs no server; this is what ships |

They used to be the same directory, and that one collision caused every blank-panel mystery this
package has had: a `pnpm build` (or any gate that builds the workspace — `pnpm test:packaging`
does) silently froze a live dev install at that moment's code, and a Chrome that reloaded *while*
Vite was rewriting the directory cached half an extension. Neither is possible now: a build and a
dev server cannot touch each other's output, and the dev build **stamps itself complete**
(`dist-dev/aiui-dev.json`, written last) so nothing tells Chrome to read it early.

## Development

```sh
# from the project whose session browser you're developing against —
# the same directory you run `aiui claude` from (that's what picks the profile):
aiui extension dev
```

That starts Vite (pinned port 5317, strict) **and**, once the dev artifact is complete and its
server is answering, reloads the extension in that project's session browser over CDP — the
ordering that used to be a manual dance is now the command's job. It also tells you what the
browser is actually running afterwards, by reading the extension's own stamp back out of it.

Two rules it exists to enforce, worth knowing anyway:

1. **Chrome must not read `dist-dev/` while Vite is writing it** → a partial extension, no error.
2. **Chrome must be told to re-read it after every dev-server start** → else it silently keeps
   serving the previous run's code.

The raw `pnpm -C packages/aiui-extension dev` still works (it just writes `dist-dev/` and prints
what to do); follow it with `aiui extension reload` from your project directory.

**First time (once per browser profile):** `chrome://extensions` → Developer mode → **Load
unpacked** → this package's **`dist-dev/`**. Chrome installs an unpacked extension *by path*, so a
profile pointed at `dist/` will never see the dev server's output — `aiui extension reload` detects
exactly that and says so. (The extension id is pinned by the manifest `key`, so switching
directories does **not** change the id: the native-messaging host manifest stays valid.) Pin the
toolbar action (puzzle-piece menu) — clicking it opens the window's side panel and invokes the tab
for capture.

**Or let aiui load it for you:** `aiui claude` / `aiui browser` append the extension to the same
`--load-extension` list as the DevTools panel (honored by Chrome for Testing / Chromium; branded
Chrome ≥ 137 ignores the flag — see `docs/guide/chrome.md`), choosing **`dist-dev/` when its dev
server is up** and the production `dist/` otherwise. So: start `aiui extension dev` before the
launch to develop; don't, to use. aiui deliberately never *builds* this package. The
native-messaging host rides along too: launches plant its manifest into the browser profile
(`<user-data-dir>/NativeMessagingHosts/` — the only place CfT looks, measured), so channel
discovery works with zero manual steps; the global `aiui extension install-native-host` is only
needed for browsers aiui does not manage.

## Running it without a dev server (production)

For *using* the tool rather than developing it:

```sh
pnpm -C packages/aiui-extension build         # writes dist/ — standalone, no HMR
aiui extension reload                         # if a session browser is already up
```

Then load `dist/` unpacked once (`chrome://extensions` → Load unpacked), or just launch the
browser with `aiui browser` / `aiui claude` **without** the dev server running — the launcher
picks `dist/` on its own. Nothing polls, nothing can go stale, and the panel says nothing about
dev servers.

## When something looks wrong

The panel is instrumented to **fail loudly, never blankly** (`src/panel/boot.ts`): a stale dev
build, an unreachable dev server, or an app that threw during render each produce a visible
banner with a **Reload extension** button. If you get a blank panel with no banner at all, the
document itself never loaded — see `docs/DEBUGGING.md`.

- **A squatted dev port fails loudly (by design).** If vite refuses to start, find the squatter
  (`lsof -iTCP:5317 -sTCP:LISTEN`); never retry as `vite <port>` — a bare positional arg is a
  root directory, not a port.
- HMR expectations: content-script edits update in place (module state stashed on `window`
  survives — see `src/content.ts`); panel edits are plain Vite HMR; service-worker/manifest edits
  reload the whole extension.

## Keyboard: the §13.6 model (disarmed ⊂ armed ⊂ in-a-turn)

One global shortcut — **⌘B** (mac) / **Ctrl+B**, rebindable at `chrome://extensions/shortcuts` —
is the state-dependent verb; nothing else opens a turn:

| state | ⌘B | Esc |
|---|---|---|
| disarmed | arm **and** start a turn | page's |
| armed, no turn | start a turn | page's (keyboard is not captured here) |
| in a turn | cancel the turn (stay armed) | same |
| tweak | **resume the turn** | page's |

**Armed is presence, not capture**: steady ring, everything passes through to the page.
**In a turn** the page keyboard routes to aiui (breathing ring; the panel's fields stay
typeable) and a single key acts:

| key | action |
|---|---|
| `i` | ink mode on/off (the flag is standing state; the pointer claim is per-turn) |
| `s` | shot (whole viewport; blue confirm flash) |
| `a` | add selection (the explicit pull) |
| `c` | clear ink (while ink mode is on) |
| `t` | tweak — page gets keyboard+pointer back, turn stays open, ⌘B resumes |
| `d` | disarm — abandon everything (turn, ink, standing tools) |
| `⏎` | send (you stay armed) |
| `esc` | cancel the turn (you stay armed) |
| anything else | swallowed + pink miss flash — never reaches the page |

Ink strokes are **page-anchored** (document coordinates — they follow scroll, live per-tab,
survive turn ends / mode exits / resizes / tab switches) and are cleared only by `c` or
disarm. The page carries nothing but the ring, the ink, and the transient flashes — every
control and hint lives in the side panel. A leader press counts as an extension **invocation**
(measured, RESULTS.md M8), so the turn-opening ⌘B is also what satisfies the tabCapture gate
on that tab. Grammar: `src/panel/leader.ts` on the shared modal kit (`aiui-viz/modal`); the
full model and divergence ledger: proposal **§13.6**; the running log:
[`docs/PHASE-A.md`](./docs/PHASE-A.md).
