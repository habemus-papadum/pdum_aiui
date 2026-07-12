# Phase C plan — the overlay's tool, hosted in the panel (no forks, no regressions)

> **Goal (user-directed, 2026-07-12):** the panel's Turn/Capture/Dev expanders are retired in
> favor of the overlay's real machinery and UI — the mode-reactive **command bar** (inline
> sliders, chips, emoji caps), the **transcript preview** (logprob coloring, animated diffs,
> inline shot thumbs), the **cheat sheet + help table**, a **trace viewer**, talk (incl.
> hands-free + mutes), share/video (smart/continuous + fps), vanishing-ink chip (fade slider +
> warp easing), and **iPad remote ink** — with ONE behavior implementation shared between the
> overlay and the extension. The overlay must not break; minor overlay changes and refactors
> to shared code are tolerated; the extension already depends on `aiui-dev-overlay`.
>
> Grounding: the §13.6 interaction model + divergence ledger (proposal) stay authoritative —
> this plan ports MACHINERY, never silently re-imports overlay semantics we deliberately
> changed (explicit ⌘B turns, per-turn capture, page-anchored `i`-modal ink, panel-first, no
> pill). The two code inventories from the 2026-07-11 review (engine API + event vocabulary;
> modality/ink/talk/shot lifecycles + host seam) are the source maps for this plan.

## 0 · The architecture in one picture

The overlay is one document; the extension is three. Everything splits along two seams — one
that already exists, one to extract:

```
                    ┌──────────────────────────────────────────────┐
   shared, host-    │  Engine + composeIntent  ·  wire shell        │
   agnostic core    │  talk shell  ·  keymap machinery (modal kit)  │
   (aiui-dev-       │  preview.tsx + diff-flash  ·  uiMode          │
    overlay)        │  HUD/command-bar content  ·  help/cheatsheet  │
                    └───────────────┬──────────────────────────────┘
                         IntentToolContext (EXISTS — the host seam)
                    ┌───────────────┴──────────────┐
                    │ overlay host                 │ extension host = THE PANEL
                    │ (page pill, .mm-layers)      │ (command bar region, panes)
                    └───────────────┬──────────────┘
                          PageSurface (TO EXTRACT — the page seam)
                    ┌───────────────┴──────────────┐
                    │ overlay: direct DOM          │ extension: relay → content
                    │ (ink canvas, watchers,       │ script (ink, watchers,
                    │  veil, locator, cursor)      │  viewport) + SW (capture)
                    └──────────────────────────────┘
```

- **The panel becomes an `IntentToolContext` host.** Everything the modality already does
  through `ctx` maps directly: `openThread` → the shared wire against the bound port;
  `hudSlot()` → a command-bar region at the top of the panel (the HUD's vanilla-DOM content —
  arm control, ink chip + fade slider, REC meter, video badge + 🦉/🔫 + fps slider,
  transcriber label — renders into it AS-IS); `setUiMode` → the ring broadcast;
  `reportError` → the toast column; `setStatus` → logInfo; selection/navigation subscriptions
  → the relay + tab events. The "layers host" (preview, config strip, future pickers) becomes
  host-provided too: overlay mounts them over the page, the panel mounts them in itself.
- **PageSurface** is the §13.6-Phase-B extraction, scoped by the measured hardwired list:
  ink layer (mount/activate/clear/stroke-events/remote-feed), viewport metrics, selection +
  navigation watchers, capture veil + locator + `elementsFromPoint` (chunk-3 features, seam
  now, implement later), armed cursor. Overlay impl = today's direct-DOM code, verbatim.
  Extension impl = the existing relay/content-script machinery.
- **Capture** stays behind the existing `MultimodalDeps.displayCapture` seam: the overlay
  keeps getDisplayMedia+crop; the extension plugs the SW tabCapture/offscreen path in.
- **Keyboard**: shared COMMAND vocabulary + dispatch; two layer TABLES. The overlay keeps its
  armed/pass-fallback stack; the extension keeps the §13.6 turn-gated swallow stack, growing
  rows as features land (Space/H/M talk, V/N share, K config, ? help; D region and J jump
  with chunk 3). Cheat sheet + help render from whichever stack is live — same hint machinery.

## 1 · Where shared code lives (decision)

**Stay in `aiui-dev-overlay`; no new package.** The extension already depends on it, the
pipeline/selection/debug-ui/protocol subpaths already exist, and a package split would churn
publishing for zero sharing benefit. Mechanics:

- `modality.ts` splits internally: `multimodal/core.ts` (host-agnostic orchestration over
  ctx + PageSurface + deps) and the overlay host wiring that stays where it is. New subpath
  exports as needed (likely `./multimodal` for core + preview + hud content, `./shell` if the
  wire/talk shells are consumed directly). **Every new subpath goes into BOTH the dev
  `exports` and `publishConfig.exports`, each with a `"default"` condition** (the repo's
  packaging trap — source-first dev masks omissions; run `pnpm test:packaging`).
- **Ink unification** (currently two near-twin implementations): `aiui-ink` becomes the one
  surface — port the overlay `Ink`'s graduated policies INTO it (warp fade curve
  hold/charge/pop, `restartFade`, per-frame fadeSec read, compositeInto parity) and swap the
  overlay to consume it. `aiui-ink` already has the remote feed and the extension's
  `documentAnchored` option. The overlay's viewport-anchored default is untouched.
- The vanilla HUD content stays vanilla (the hudSlot is an escape hatch by design; the
  "overlay should be Solid" goal is real but explicitly NOT this refactor).

## 2 · Work phases (each: gates + a live overlay check + a live panel check + log entry)

**C0 — measurements first (the platform gates on which phases hang):**
1. `getUserMedia` (mic) from the side panel document — if the prompt can't fire there, the
   fallback is a one-time grant page (options page); measure, record in RESULTS.md.
2. Preview mount smoke: render `preview.tsx` + its `mm-` styles inside a panel div (it's
   Solid + light-DOM by design — expected fine; measure, don't assume).
3. `debug-ui` embed smoke in a panel pane against the bound channel's `/debug/api`.
4. Read `paint-host.ts` end-to-end: exactly how iPad strokes reach the overlay's sink today
   (channel → page socket → `window.__AIUI__` sink), to design the panel route (C7).

**C1 — the wire (biggest silent de-dup):** replace the panel's hand-rolled `attachTurnHost`
with the shared wire shell — event batching, attachment discipline, lowered-echo merging,
acks, cancel/finalize, config-on-hello. Requires the C-side engine gaps from §13.6 Phase B:
explicit `openTurn()` verb, send-without-disarm option, `strokeDone` no-auto-open,
`onEvent` unsubscribe, `tab-switch` context event, TurnStore persisting mode. Overlay
behavior pinned by its existing tests + one live session.

**C2 — PageSurface extraction + ink unification** (overlay-identical refactor): the seam
lands in `aiui-dev-overlay`; the overlay implements it with today's code; the extension
implements ink/viewport/watchers over the relay. Ink policies unify in `aiui-ink` (§1);
the §13.6 ink divergences (page-anchored, `i`-modal, C/disarm-only clears) live in the
EXTENSION host config, not in forked surface code.

**C3 — command bar + cheat sheet + help:** the panel claims `hudSlot()` into a command-bar
region under the header; the HUD's mode-gated widgets arrive as-is (ink chip → fade slider +
easing behavior incl. `restartFade` semantics; REC meter; video badge/mode/fps; transcriber
label); the cheat sheet renders below from the extension's layer stack; `?` opens the help
table generated from the same rows. The Turn/Capture/Dev panes retire piecemeal (compose box
survives as a small adjunct; Dev pane's probes fold into the trace/dev area).

**C4 — transcript preview:** `preview.tsx` (fold render, streaming-dim partials, logprob
coloring, diff flash, shot thumbs with hover-peek + ✕ shot-drop, selection pills) mounted in
the panel. Retires TurnPane's chip list.

**C5 — talk:** the talk shell runs in the panel document (C0.1 gate): Space hold / H
hands-free / M mute rows join the turn grammar; REST + PCM lanes over the shared wire;
barge-in; §13.6 standing-hands-free semantics (mic meter live between turns, ZERO audio sent
outside turns — the panel host enforces the send-gate, which is exactly why C1's shared wire
must come first).

**C6 — share/video:** the sampler behind the capture seam drives SW tabCapture; smart 🦉 /
continuous 🔫, fps slider, N mute; frames are ordinary shots (never flash, §13.6); spans
turns per §13.6 (sampling continues, frames only enter open turns).

**C7 — iPad remote ink:** route the paint stream to the panel (bus) and relay strokes to the
content script's surface (`aiui-ink` remote feed already exists; `documentAnchored` maps them
at ingestion). §13.6: remote ink renders whenever armed, turn or not, and never opens turns.
Design confirmed against C0.4's read of the overlay's routing.

**C8 — trace viewer + config strip:** a Trace pane embedding `debug-ui` (session-pinned to
the bound channel, like the overlay's 🔍); K config strip + advanced-config editor port last
(they touch persisted config — `chrome.storage` replaces localStorage behind a small seam).

## 3 · Risks & mitigations

- **Overlay regression** — every phase refactors under it. Mitigation: its unit tests are the
  contract; one live overlay session per phase (the user's browser tab); phases C2/C1 are
  behavior-identical refactors by construction, reviewed as such.
- **Mic in the side panel** (C0.1) — unknown; fallback designed (grant page).
- **Keymap collisions in the panel** — Space-to-talk vs typing in the compose box:
  `isTypingTarget` already yields; the §13.6 per-turn capture bounds the risk to open turns.
- **CSS in the panel** — `mm-` styles were written for over-page layers; expect a scoped
  wrapper + token alignment pass (C3/C4), not a rewrite.
- **Scope discipline** — chunk-3 features (region shots, jump/locator) get their seam methods
  now but NO implementation; anything not in the §13.6 ledger that smells like a semantic
  choice goes back to the user before code.

## 4 · Order & checkpoints

C0 (one sitting, answers recorded) → C1 → C2 → C3 → C4 (each ends with a user-verified live
run of BOTH hosts) → C5 → C6 → C7 → C8. PHASE-A.md's log pattern continues in this file —
per-phase entries: what moved, what's bridged, what was measured live.

## Log

**C0 (2026-07-12, all measured/read):**
1. **Mic in the side panel: YES** (RESULTS.md M9) — real device track via getUserMedia in the
   panel document under the session browser's auto-accept flag; permission never persists
   ("prompt" before/after — the flag accepts per call). Non-flagged browsers → one-time grant
   page, deferred until such a target matters. C5 is unblocked in the dev posture.
2. Preview mount smoke: deferred into C4 proper (it is Solid + light-DOM by design).
3. debug-ui: `TracesPane` (list + live-followed TraceView, session-filtered) is the
   embeddable surface; `./debug-ui` subpath already exported. C8-lite is additive.
4. Paint routing read: the dev page runs `installPaintHost` (probe `GET /paint/info`, then
   `startPaintHost` from aiui-paint), bridging remote strokes → the modality's
   `window.__AIUI__.remotePaint` seam and iPad view-frames → the page's one displayCapture
   grant. C7 design: the PANEL is the paint host (bus-adjacent connection to the bound
   channel), strokes relay → content-script `aiui-ink` remote feed (documentAnchored maps at
   ingestion), view-frames come from the SW tabCapture sampler instead of getDisplayMedia.

**C1 (2026-07-12, DONE — E2E verified over CDP):**
- Engine grew the three §13.6 verbs, all non-breaking and unit-tested: `openTurn()` (explicit
  thread-open, trigger `"explicit"` added to the vocabulary — the channel treats triggers
  opaquely, checked), `send({ keepArmed })` (overlay default unchanged), `onEvent` now returns
  an unsubscribe.
- `openIntentThread` extracted (`aiui-dev-overlay/intent-thread`) — the thread adapter that
  intent.ts and the panel now share; `IntentThread`/`OpenThreadOptions` moved to a LEAF
  `intent-types.ts` (a type-only import of intent.ts still pulls the whole multimodal graph
  into a consumer's TS program — found the hard way via cross-file interface merging errors).
- The panel adopted the shared `createWire` (`aiui-dev-overlay/wire`): batching, attachment
  discipline, bad-ack toasts, finalize/cancel, lowered-echo merging (which C5 needs) — the
  hand-rolled `attachTurnHost` twin is DELETED. Panel keeps: turn mirror, lowered-prompt
  display (via the adapter's `onSocket` hook), tab-identity hello meta.
- Bridges retired: the armed(false) re-arm hack (send keeps armed for real now) and the
  lazy-thread bridge (⌘B calls `engine.openTurn()`; empty explicit turns cancel on send
  instead of lowering nothing). Boot recovery waits briefly for the auto-bind so a replayed
  turn re-streams into a live socket.
- New subpaths `./wire` + `./intent-thread` in BOTH export maps; `pnpm test:packaging` green.
  Gotcha for the log: the dev server must RESTART after export-map changes (stale resolution
  rendered the panel blank — "createWire is not defined").
- Verified: 645 overlay + 27 extension tests; repo suite 1668; live E2E over raw CDP — panel
  armed → explicit turn → compose → send; the turn arrived in the Claude session through the
  shared shell; post-send state armed-lit/turn-off per §13.6.

**C2a (2026-07-12, DONE):** ONE ink implementation. `aiui-ink` absorbed the overlay's
graduated policies — the warp fade curve (`fade.ts`: hold → charge → pop, `heat`, tested),
`restartFade` (the ✒️→💨 chip flip), `strokeCount`, `shouldCapture` (shift = inspect, never
ink), `minCommitPoints` (taps are nothing for the overlay, dots for paint), FULL-style
`compositeInto`, and an `onRemoteStrokeEnd` callback (remote strokes join the engine like
local ones — and C7's iPad relay will ride the same hook). The overlay's `multimodal/ink.ts`
is now a thin adapter over `InkSurface` with its exact old API + re-exports — modality.ts
untouched, all 81 modality tests + its ink tests green unchanged. Overlay gained the
`aiui-ink` workspace dep (both public). Extension side already consumed `aiui-ink`
(documentAnchored); nothing to change. 1673 repo tests, packaging green.

**C8-lite (2026-07-12, DONE — live-verified):** a **Trace pane** embeds the shared debug-ui
`TracesPane` (the same surface the overlay's 🔍 opens), pinned to the BOUND channel and
polling only while expanded (`Pane` gained an `onToggle` hook in aiui-webext; the pane
rebuilds on port change). Live: 21 traces listed, the follow-view rendering a real lowering
(15 stages) — including the turns sent through C1's shared wire.

**Dev-loop trap (cost a debugging round, worth remembering):** CRXJS pre-bundles each HTML
page's ENTRY at dev-server startup. Edits to existing modules hot-update fine, but a **NEW
module file** (here `trace-pane.tsx`) is not in the pinned entry graph — the panel silently
renders the old tree, no error. Restart the dev server after adding a module, exactly as after
an export-map change (C1).

**C4 + C3-lite (2026-07-12, DONE — live-verified):** the panel now renders the OVERLAY's real
surfaces, not lookalikes.
- New subpath `./multimodal-ui` exports the host-agnostic UI classes (`Preview`, `CheatSheet`,
  `KeymapHelp` + their stylesheets). Nothing in them touches the page, `window.__AIUI__`, or
  the widget — they are DOM-in/DOM-out over the shared engine.
- **Transcript preview** (C4): the Turn pane's body IS `Preview` — the compiler's accumulator
  (`composeIntent(…, { streaming: true })`), word-confidence heat, animated diffs, shot thumbs
  with ✕ retraction, selection pills. The hand-rolled chip list is gone. Panel geometry is
  applied with MORE SPECIFIC selectors (`.preview-host .mm-preview`), never by editing the
  shared stylesheet.
- **Cheat sheet + help** (C3-lite): `CheatSheet` renders the live caps for the extension's own
  key layer (leader.ts — same hint machinery, different grammar), and `?` opens `KeymapHelp`
  over `leaderHelp()`, generated from the REAL stack (⌘B is an authored row: it is a
  browser-global command, not a stack binding). Cap taps synthesize the key through the panel's
  resolver. New `help` action + row; tests updated (28 extension tests).
- **Solid 2.0 trap, cost a live round (now in CONTINUITY trap 2's family):** these shared
  classes own internal signals, so BUILDING or UPDATING them inside an owned scope (component
  body or `createEffect`) throws `[REACTIVE_WRITE_IN_OWNED_SCOPE]` — `KeymapHelp.render()`
  writes on construction. They are now built in a **queueMicrotask** (outside the owner) and
  driven by a plain `syncIslands()` called from phase transitions and engine events. Imperative
  islands: never reactive.
- Verified live over CDP: caps `✏️ 🖼 📋 🔧 💤 📤 ❓ esc`, preview rendering a real transcript
  run, `?` (keyboard AND cap tap) toggling the 4-section help table, send → armed stays / turn
  clears / preview hides. Repo suite 1674, packaging green.

## 5 · Decision points for review (before any code)

1. **Shared code stays in `aiui-dev-overlay`** (no new package) — confirm.
2. **Ink unifies INTO `aiui-ink`** (overlay adopts it; policies ported with tests) — confirm.
3. **Talk mic lives in the panel document** (C0.1 measurement decides the grant flow) — ok?
4. **Command bar replaces the panes** progressively (compose box survives as adjunct) — ok?
5. **The §13.6 ledger governs every conflict** between overlay behavior and extension
   semantics — reaffirm (it decides, e.g., that send keeps you armed even though the
   overlay's send disarms, and that share frames never flash).
