# @habemus-papadum/aiui-extension

The aiui intent tool as a Chrome MV3 extension: per-window side panel (the tool's whole visible
surface), channel binding, capture, ink, page tools. Design:
`docs/proposals/browser-extension-intent-tool.md`; measured groundwork:
`archive/extension-spikes/RESULTS.md`. Built on
[`@habemus-papadum/aiui-webext`](../aiui-webext/README.md).

> **Picking this work up fresh?** Read [`docs/CONTINUITY.md`](./docs/CONTINUITY.md) first — status,
> working agreements, the traps that already cost cycles, and the ordered plan for what's next.

## Development

```sh
pnpm -C packages/aiui-extension dev     # Vite dev server, pinned port 5317 (strict)
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → this package's `dist/`.
The persistent session-browser profile keeps it installed; pin the toolbar action (puzzle-piece
menu) — clicking it opens the window's side panel and, later, invokes the tab for capture.

**Or let aiui load it for you:** whenever `dist/` exists, `aiui claude` / `aiui browser` append
it to the same `--load-extension` list as the DevTools panel (honored by Chrome for Testing /
Chromium; branded Chrome ≥ 137 ignores the flag — see `docs/guide/chrome.md`). Start this
package's dev server *before* launching so `dist/` exists and is being served; launches warn
when the dist is dev-shaped and nothing answers on its port. aiui deliberately never builds
this package (see the trap below). The native-messaging host rides along too: launches plant
its manifest into the browser profile (`<user-data-dir>/NativeMessagingHosts/` — the only place
CfT looks, measured), so channel discovery works with zero manual steps; the global
`aiui extension install-native-host` is only needed for browsers aiui does not manage.

Two things the spikes taught, now load-bearing:

- **`dist/` has two shapes.** `pnpm dev` writes HMR loader stubs that require the dev server;
  `pnpm build` writes the standalone production extension. After switching modes, **Reload** the
  extension in `chrome://extensions` — same path, different artifact. **Corollary (learned the
  hard way, twice):** running `pnpm build` as a CI-style gate while a dev install is live
  silently freezes the installed extension at that moment's code — the dev server does NOT
  rewrite `dist/` on edits, only on startup. After any `pnpm build`, restart `pnpm dev` before
  touching the browser again.
- **A squatted dev port fails loudly (by design).** If vite refuses to start, find the squatter
  (`lsof -iTCP:5317 -sTCP:LISTEN`); never retry as `vite <port>` — a bare positional arg is a
  root directory, not a port.

HMR expectations: content-script edits update in place (module state stashed on `window`
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
