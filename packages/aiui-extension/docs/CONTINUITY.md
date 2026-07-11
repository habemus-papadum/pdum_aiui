# Continuity — browser-extension intent tool

> **Purpose:** let a fresh agent (or human) with none of the original session's context pick up
> this work. Read this top to bottom, then the canonical docs it points to, before writing code.
> Last updated: **2026-07-11**, immediately after the six-step foundation was verified live.

## What we are building

A Chrome-extension version of the aiui web intent tool: instead of a dev overlay mounted inside
one web app, the intent tool lives in a **per-window side panel**, binds to an `aiui claude`
channel via native-messaging discovery, and works on *any* page — capture (screenshots), ink
annotation, selection slurping, and tab-aware page tools. The web overlay and the extension
coexist with **no deference logic** — they are separate sessions; the user picks per window.

Canonical reading, in order:

1. `docs/proposals/browser-extension-intent-tool.md` — the design doc. §12 tracks status, §13.5
   is the interaction grammar (decided live with the user), §5/§6 capture + iPad conclusions.
2. `archive/extension-spikes/RESULTS.md` — measured platform facts (M1–M6). Trust these over
   intuition; several "obvious" assumptions were falsified live.
3. `packages/aiui-extension/README.md` — dev-loop instructions and the build trap.
4. Root `CLAUDE.md` — workspace conventions (source-first editable deps, publication levels).

## The two packages

- **`packages/aiui-webext`** — the reusable kit ("pretend we'll write more than one extension"):
  - `src/vite.ts` — `webextConfig({manifest, devPort, fsAllow})`: solid() + CRXJS, strict port,
    HMR client port, `fs.allow`. Re-exports `defineManifest`. Subpath export `./vite`.
  - `src/relay.ts` — `serveRelay(address, handlers)` / `relayRequest` / `relayRequestTab`:
    `{aiui:1, to, cmd, payload}` envelopes, `RelayResult` tagged union. Addresses: `"sw"`,
    `"page"`, `"offscreen"`.
  - `src/panes.tsx` — `PaneStack`/`Pane` collapsible panes (children stay mounted when collapsed).
  - `src/indicator.ts` — `mountIndicator()`: minimal in-page armed ring (fuzzy inset glow, the
    user rejected hard borders) + badge dot.
  - `src/offscreen.ts` — `ensureOffscreenDocument()` single-flight.
- **`packages/aiui-extension`** — the actual tool. Surfaces and their strict roles:
  - **Side panel = the per-window brain** (`src/panel/`): the intent-pipeline `Engine`, channel
    binding, turn host, capture orchestration, tools link. Everything stateful lives here.
  - **Content script** (`src/content.ts`): indicator + ink surface + selection watcher ONLY.
    Modes are the panel's state; the page obeys relay commands and reports facts.
  - **Service worker** (`src/sw.ts`): plumbing — invocation ledger, `getMediaStreamId`,
    offscreen-document management, `action.onClicked` → open panel.
  - **Offscreen doc** (`public/offscreen.html|js`): static capture room (CRXJS cannot bundle
    runtime-created pages). Always min=max width/height constraints; stops the stream in
    `finally`.

Both packages are `--private` (publishable, restricted). `pnpm npm:reserve` / `pnpm npm:trust`
for them are **the user's local 2FA steps** — parked, do not attempt from an agent.

## Status: all six foundation steps DONE and human-verified (2026-07-11)

| Step | What | Verified |
|---|---|---|
| 1 | Kit + extension scaffold, CRXJS dev loop, in-page HMR | live (badge edit updated in place) |
| 2 | Native-messaging channel discovery (`aiui native-host`, `aiui extension install-native-host`) | live (rescan lists channels without a typed port) |
| 3 | Session binding + session-bus peers pane | live (peer list showed test peer) |
| 4 | Arm/disarm, selection **pull** model, turns with chips | live (selection-only turn landed in session) |
| 5 | Capture: tab shots via offscreen, ink mode, multi-shot turns | live (4-shot turn, ink visible in shot_3) |
| 6 | Tab-aware page tools: panel `/tools` activation link, `activeTab` flags, `tools/list_changed` + session pushes, active-tab call routing | live (probe registered on a real tab; flag flipped on switch-away/back; routed call returned; teardown pushed "none registered") |

Step-6 wire shape (channel side, `packages/aiui-claude-channel/src/page-tools.ts`): panel sends
`{v:1, type:"activation", tab:{chromeTabId, windowId}, active:true}` on `/tools` at connect and
on every `tabs.onActivated`; the directory flips `activeTab` flags (active-first sort,
active-preferred routing) and a debounced (~500 ms, signature-gated) change signal drives
`sendToolListChanged()` + a `notifications/claude/channel` push (`meta.kind: "page-tools"`;
disable with `--no-page-tools-notify`). A standalone probe script exists in the original
session's scratchpad (`tools-probe.mjs`) — trivially rewritable: register a ns on `/tools` with a
real `chromeTabId`, answer `call` messages.

### Loose end at time of writing

- `src/panel/main.tsx` has an **uncommitted** fix (the Solid 2.0 `createEffect` two-arg fix, see
  traps below). Everything else was pushed by the user before it. Commit/push is the user's call.

## Working agreement with the user (do not drift from these)

- **Meta-principle:** de-risk the things only debuggable with a human in the loop. Work
  step-by-step; when a checkpoint needs the user, give **clear numbered instructions at that
  moment** (not in advance), and wait.
- **Interaction grammar (decided live, proposal §13.5):** selection is EXPLICIT pull — select,
  then a panel command slurps it; the slurp auto-opens the turn (no staging). "Armed" carries NO
  mode. Keyboard will be leader-key modal (e.g. Cmd-B, then single keys), sharing overlay
  machinery. Arm button disabled unless bound.
- **Structured inputs:** intent inputs travel structured; prompt formatting is
  composeIntent/channel's decision, never the capturing view's.
- **Git:** direct merges to main, no PRs. The user often pushes `sync` commits themselves.
- **Gates:** biome + typecheck + tests with REAL exit codes — never pipe a gate through `tail`
  and read the pipe's status. `pnpm test:packaging` whenever packaging fields change.

## Traps that already cost us cycles (symptom → rule)

1. **`pnpm build` in `aiui-extension` silently freezes a live dev install.** Dev `dist/` is CRXJS
   loader stubs that require the Vite dev server (pinned strict port **5317**); `pnpm build`
   writes production output to the SAME `dist/`. Symptom: extension goes blank/stale, no error.
   Rule: NEVER run build in this package while a dev install is loaded; after any build, `rm -rf
   dist` and restart `pnpm dev`, then **Reload the extension** in `chrome://extensions`. A
   mixed-timestamp `dist/` (`ls -laT dist/`) is the fingerprint of a partial overwrite.
2. **Solid 2.0 `createEffect` requires TWO functions** — `createEffect(compute, effect)`. One-arg
   `createEffect(() => {…})` *typechecks* but throws `[MISSING_EFFECT_FN]` at render and blanks
   the whole panel. tsc/biome/node-vitest cannot catch it. Other Solid 2.0-beta.15 gotchas:
   `render`/JSX types from `@solidjs/web` (not `solid-js/web`), no `onMount` (run in component
   body), no `classList` JSX prop, aria-* values are strings.
3. **Port squatting from other checkouts.** A Vite from `pdum_aiui-review-pr1` squatted an
   earlier pinned port and served a wrong module graph. Rule: on weird dev behavior, check WHO
   owns the port (`lsof -nP -iTCP:5317 -sTCP:LISTEN`) and its `cwd` before debugging code. Also
   note Vite may bind `[::1]` only.
4. **tabCapture is invocation-gated per tab.** The user must "invoke" the extension on a tab
   (toolbar click) before `getMediaStreamId` works there; grants survive SW restarts but die on
   navigation. This is platform law; the planned softener is `chrome.commands` shortcuts (which
   count as invocations). Surface failures loudly — a silent no-op shot read as "button broken".
5. **Headless measurements lie.** Anything involving capture, focus, or invocation must be
   verified with the human in a real browser. See `archive/extension-spikes/RESULTS.md`.

## Dev-loop quickstart

```sh
# terminal 1 — Claude session + channel (from a demo or repo root)
pnpm -C demos/gallery claude
# terminal 2 — the extension dev server (pinned :5317)
pnpm -C packages/aiui-extension dev
# then: chrome://extensions → Load unpacked → packages/aiui-extension/dist
```

Extension ID is pinned via `key` in `manifest.config.ts`: `ngakidpkjdgaajnlpggbchpaikilkpmp`.
Native host manifest install: `pnpm -C packages/aiui exec tsx src/cli.ts extension
install-native-host` (already installed on the dev machine; covers Chrome/CfT/Chromium/Edge).
Icons come from the gallery favicon.

Verifying channel-side behavior from a session: `mcp__aiui__channel_info` (port),
`mcp__aiui__page_tools_list` / `page_tools_call`, and watch for `<channel source="aiui"
kind="page-tools">` pushes.

## Next big chunks (rough plan, in order)

1. **Leader-key keyboard layer.** `chrome.commands` global shortcut as the leader (ALSO counts as
   an invocation — this is the invocation-gate softener), then a modal single-key layer (i = ink,
   s = shot, a = add selection, …) rendered by the panel/indicator machinery. Shares the grammar
   with the future web-overlay leader keys. Design sketch in proposal §13.5.
2. **Tools pane + Trace pane.** Tools pane: live `page_tools_list` view in the panel (the
   directory already pushes changes). Trace pane: embed the shared `debug-ui` viewer
   (session-pinned, like the overlay's 🔍) in a collapsible pane.
3. **Region shots + component locator.** Crop-after-grab in the offscreen room (tracks have NO
   `cropTo`/`restrictTo` — measured M1); selection rectangle UI via the ink/indicator layer;
   map rectangle → component/source using the frontend-for-agents instrumentation.
4. **In-tab SPA navigation boundaries.** Mirror the web overlay's `navigation` engine events for
   tab-internal navigations (`webNavigation` / tab URL changes), and clear ink at boundaries
   (panel already clears ink on tab *switch*).
5. **Talk modality** (speech input into the turn), then **iPad re-pointing** and **remote
   tunnels** (proposal §6/§9).
6. **Release plumbing** — `npm:reserve` + `npm:trust` for `aiui-webext` + `aiui-extension`
   (user-local, 2FA), then they ride the normal CI release.

Smaller debt, whenever touching the area: shot retraction (remove a chip), config pane (fade
seconds etc.), the one-time rebind flake after panel reopen (windowId race suspected), HMR
listener leaks in long dev sessions, and replacing the step-1 click-counter badge scenery.

## Key file map

```
packages/aiui-webext/src/           vite.ts · relay.ts · panes.tsx · indicator.ts · offscreen.ts
packages/aiui-extension/
  manifest.config.ts                MV3 manifest (pinned key, permissions, content script)
  src/sw.ts                         invocation ledger · capture relay · panel opening
  src/content.ts                    indicator · ink · selection watcher · relay server "page"
  src/capture.ts                    capture types + data-url utils
  public/offscreen.{html,js}        the capture room
  src/panel/main.tsx                Panel component: engine, arming, shots, tools-link wiring
  src/panel/turn.ts                 attachTurnHost (intent-v1 socket) · turnMirror
  src/panel/turn-pane.tsx           compose + turn UI (chips via composeIntent)
  src/panel/session-pane.tsx        discovery (native host → port scan) · binding · peers
  src/panel/channel.ts              probeHealth · listChannels · native host name
  src/panel/bus.ts                  session-bus client + reducer
  src/panel/tools-link.ts           /tools activation link (step 6)
packages/aiui/src/commands/         native-host.ts · extension.ts (CLI side)
packages/aiui-claude-channel/src/   page-tools.ts (directory, activation, change signal)
```
