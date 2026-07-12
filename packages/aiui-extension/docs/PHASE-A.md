# Phase A implementation log — the §13.6 interaction model

> **Spec:** `docs/proposals/browser-extension-intent-tool.md` §13.6 (the state machine, the
> ⌘B/Esc/T table, the 9-row divergence ledger). This file is the running log: what changed,
> what's bridged-until-Phase-B, what's next. Update it with every work session — it exists so
> we never drift from the decided model again.
>
> Started 2026-07-11 (same session as the §13.6 decisions). Status legend: ☐ todo · ◐ in
> progress · ☑ done · ⚠ bridge (extension-local workaround; the real fix is Phase B upstream).

## The model in one paragraph (see §13.6 for the full spec)

disarmed ⊂ armed ⊂ in-a-turn. Armed = border only, everything passes through; standing state
(ink mode + strokes, hands-free, share, remote ink) lives here and outlives turns. Capture is
per-TURN: keyboard while a turn is open (+ pointer when ink mode on). ⌘B is the ONLY
turn-opener (disarmed → arm+turn; armed → turn; in-turn → ladder; tweak → resume). Esc = same
ladder but only reachable in-turn (page owns it otherwise). T = tweak (release all capture,
turn stays open, ⌘B resumes). Send/cancel keep you armed. Disarm (d in-turn / panel button) =
abandon everything incl. ink. Ink: `i`-modal, page-anchored (document coords, follows scroll,
per-tab, survives turn end/mode exit/resize/tab switch), cleared ONLY by C/disarm. Page shows
border + ink + transient flashes, nothing else. Panel owns all controls/hints/sliders.

## Work items

### 1. Grammar rewrite (`src/panel/leader.ts`) — ☑ (2026-07-11)
- ☑ State: `phase: "armed" | "turn" | "tweak"` (+ disarmed as non-state: no grammar runs),
  `inkOn`, `armed` dropped in favor of phase, `selectionPresent` kept for hints.
- ☑ Layer active ONLY in `phase === "turn"`. Keys: `i` ink-mode toggle · `s` shot · `a` add
  selection · `c` clear ink (ink strokes present… gated on inkOn for now, see item 8) · `d`
  disarm · `t` tweak · `Enter` send · `Esc` cancel-turn (ladder rung). Unknown → miss-blip.
- ☑ Table tests updated (leader.test.ts).

### 2. Page-anchored ink (`aiui-ink` + content script) — ☑ (2026-07-11)
- ☑ `InkSurface` gains opt-in `documentAnchored: true`: strokes stored in DOCUMENT
  coordinates (client + scroll at capture); draw subtracts live scroll each rAF frame (the
  paint loop already runs continuously). Remote strokes doc-anchored at ingestion. Additive —
  the paint sidecar / iPad path is untouched without the flag.
- ☑ Reflow NOT tracked (decided; strokes keep document coordinates when text re-wraps).
- ☑ Resize-clear listener DELETED from content.ts (divergence: strokes survive resize).
- ☑ Tab-switch ink clear DELETED from panel (strokes are per-tab page state now).
- ☑ Content script: strokes survive turn end / ink-mode exit; cleared by relay `ink
  {clear:true}` only (C / disarm paths).

### 3. Page chrome reduction (indicator) — ☑ (2026-07-11)
- ☑ The anchor pill (dot + label + badge + click handler) is GONE from the page. The
  indicator is now: ring (armed = steady, in-turn = breathing, tweak = steady) + the flash
  layers (blue shot-confirm, pink miss-blip). Nothing else is capturable.
- ☑ Hint strip renders in the PANEL header only.
- ☑ Step-1 click-counter badge scenery retired with the pill (was listed debt).

### 4. State machine in the panel (`src/panel/main.tsx`) — ☑ (2026-07-11)
- ☑ `phase` signal: "disarmed" | "armed" | "turn" | "tweak". ⌘B transitions per the §13.6
  table; Esc/d/T arrive only via in-turn key capture.
- ☑ Key capture relayed to the content script ONLY while in-turn (on at turn open / resume;
  off at cancel/send/tweak/disarm). Armed-no-turn: page keyboard untouched.
- ☑ Pointer (ink drawing) active only in-turn + inkOn: content `ink {on}` follows
  (turn+inkOn), stroke rendering persists regardless.
- ☑ Send (Enter or panel button) → turn closes, STAY ARMED. ⚠ bridge: engine.send()
  disarms (reference behavior); panel re-arms immediately after (one spurious armed
  false/true pair in the log; Phase B adds send-without-disarm).
- ☑ ⚠ bridge: engine has no explicit turn-open verb; panel keeps its own phase and lets the
  engine thread open on the first contentful act (acts are phase-gated, so the engine thread
  is always ⊆ the panel turn). Phase B adds `engine.openTurn()`.
- ☑ ⚠ bridge: stroke events forwarded to the engine only while in-turn (engine.strokeDone
  would implicitly open a thread; drawing between turns is whiteboard-only by design).
- ☑ Disarm: engine.setArmed(false) + ink clear relay; the hands-free/share teardown spot is
  marked with a comment in `disarm()` — wire real teardown there when talk/share land (C).
- ☑ Navigation/tab-switch boundary still emits `navigation` on an open turn; ink no longer
  cleared by it.

### 5. Flash rules — ☑ (2026-07-11)
- ☑ Manual shot flash stays. Share flash: nothing to do yet (no share until Phase C) — rule
  recorded in §13.6 so it lands right when share ports.
- ☐ Easy off-switch for the shot flash (a panel config knob) — deferred until the config pane
  exists (Phase C brings the command-bar tenants).

### 6. SW / manifest — ☑ (no changes needed)
- ⌘B stays `commands["aiui-leader"]`; all semantics live in the panel. Invocation ledger +
  panel-open + pendingLeader hand-off unchanged.

### 7. Gates + docs — ☑ (2026-07-11)
- ☑ biome / typecheck / vitest green across the repo.
- ☑ README keymap table rewritten to the §13.6 model.
- ☑ CONTINUITY.md updated (Phase A started/done pointers).

### 7.5 Live round 1 (2026-07-12) — found & fixed

- **Ring one transition behind + `d` left the header "armed"** — one root cause: Solid 2.0
  DEFERS signal writes, so `phase()` read right after `setPhase()` returned the STALE value.
  `broadcastRing()` broadcast the previous state's ring (in-turn = no blink, leaving = blink),
  and worse: `disarm()` set the phase, then `engine.stepOut()` fired `thread-close`
  *synchronously*, whose handler still read "turn", stomped the phase back to "armed", and the
  armed(false) re-arm bridge then re-armed the engine. FIX: the machine's truth is a plain
  `phaseNow` variable set synchronously alongside the signal; ALL machine logic (broadcast,
  event guards, dispatch, grammar state) reads `phaseNow`; only JSX reads the signal. Rule for
  the future: **never read a Solid 2.0 signal to make a decision in the same synchronous flow
  that wrote it** (also recorded in CONTINUITY trap 2).
- Everything else in round 1 passed per the user ("pretty close"): ⌘B cold start, compose,
  send-lands-in-session, keys passing through when armed-no-turn.

### 7.6 Frontend-methodology pass (2026-07-12, user-requested review + modernize)

Review verdict: the panel had NO model layer — raw signals and signal-and-forget promises
everywhere; no control surface (inkFadeSec was unreachable, the promised shot-flash switch
didn't exist); no compiler wiring, so `control()`/`cell()` could never have run. What changed:

- ☑ **Compiler wired**: `webextConfig` grew a `prePlugins` slot (aiui-webext); the extension's
  vite.config passes `aiuiDevOverlay({ locator: true, mount: false })` (compiler only — the
  panel IS the tool, nothing overlays it); vitest.config mirrors it (jsdom + solid inline, the
  template's shape; manifest.test pinned back to node — esbuild's TextEncoder invariant breaks
  under jsdom).
- ☑ **`src/panel/model/store.ts`**: controls `inkFade` (0–10 s, 0 = permanent; live-updates an
  inked tab via a panel effect + a content-side live var) and `shotFlash` (the §13.6 easy-off,
  now real); `inkMode` as a durableSignal (standing §13.6 flag, survives panel hot swaps);
  `rescanTick` internal.
- ☑ **`src/panel/model/graph.ts`**: `hotCellGraph("panel", panelCells, import.meta.hot)` with
  `channels` (discovery: native host → port-scan fallback; `discoverOnce` shared with the boot
  auto-bind so the two paths can't drift) and `swPing`; `rescan` as an `action()`. Rendered
  through CellView in the Session + Dev panes; ControlSlider/ControlToggle in the Capture pane
  (mode-gated, the overlay command-bar convention).
- ☑ **Headless tests** (`graph.test.ts`): cellHarness + per-input tick probes + compiler-name
  assertions + bound clamping; chrome stubbed. 27 extension tests total.
- **Deliberately NOT converted** (each has a reason): the §13.6 state machine stays a plain
  `phaseNow` imperative island (trap 2 — deferred signal writes); the bus client stays
  imperative (a live connection is not a cell); the Engine is NOT `durable()` yet — blocked on
  the missing `onEvent` unsubscribe (Phase B gap; a durable engine would accumulate listeners
  per hot swap); `agentToolkit`/`registerStandardTools` deferred to Phase C (the /tools link is
  the forwarding path; wiring it belongs with the modality port). Typed-port rescan seeds were
  dropped (typed ports connect directly; the cell rescans recents).

### 7.7 Accessibility sizing + panel zoom (2026-07-12)

Browser zoom (⌘+) does not reach side panels, and the panel's hardcoded px fonts ignored the
browser's accessibility font-size setting entirely. Now:

- ☑ All panel sizes are **rem** (index.html base 0.8125rem, PANEL_STYLES, and the kit's
  PANE_STYLES — hairline borders stay px): Chrome Settings → Appearance → Font size flows in
  with zero knobs.
- ☑ **⌘+/⌘−/⌘0 zoom inside the panel** — a `uiScale` control (0.6–2.0, bounds clamp the
  steps; deliberately NO widget, per the user) applied as a *percentage* root font-size, so
  it MULTIPLIES the accessibility default instead of replacing it. Persisted in
  chrome.storage.local across panel reopens. The chord listener registers before the turn
  grammar and stops propagation, so zoom wins mid-turn.
- ☑ Style-guide alignment: all stylesheet color now goes through **:root tokens** (dark
  values, index.html; the kit reads them with fallbacks). Known conflict, acknowledged by the
  user: the overlay's own CSS is px-based — the extension diverges here deliberately. Light
  theme variant + the same treatment for aiui-devtools-extension: future work.

### 7.8 Header streamline (2026-07-12, user-directed)

Order: ✳ mark · **connection chip** · **armed pill** · **turn pill** · win. The pills are
chip-shaped BUTTONS (dot + word, lit/gray, no shortcut text): pure readers of the `phase`
signal, so they react to every source of change (⌘B, d, engine closes — everything funnels
through setPhase); clicks call the machine's verbs. Armed click: cold → `armOnly()` (NEW verb:
presence without a turn — ⌘B stays the only turn-opener); on → `disarm()` (abandon all). Turn
click: armed → open turn; on → cancel (send stays on ⏎/Send — a toggle-off must be the safe
verb); disabled while disarmed. The old "disarmed — ⌘B" label + separate disarm button are
gone.

### 7.9 Session pane retired into the connection chip (2026-07-12, user-directed)

- The header chip now shows **"name :port"** (channelLabel), with three states: green =
  connected, **amber = bound but re-dialing** (the bus client's own reconnect loop — a channel
  restart under hot-reload self-heals and NEVER touches armed/turn; nothing couples the phase
  machine to the socket), gray = unbound.
- The chip is a **dropdown that rescans on open**: new `Dropdown` widget in **aiui-viz**
  (root barrel, `dropdown.tsx` + tests) — the widget owns ONLY the popup lifecycle with an
  `onOpen` refresh hook; trigger and body are arbitrary host JSX (the extension's body:
  discovery CellView list, binding status, peers, disconnect). The library-worthiness call the
  user made; extracted with docblocks + behavioral tests per the methodology.
- Session logic went headless: `session.ts` (`createSession()` — bind/unbind, remembered-port
  + auto-bind boot, bus island); `session-pane.tsx` deleted; **explicit-port entry dropped**
  (decided: discovery covers the flows; revisit if a portless setup appears).

### 7.10 Advisory redesign: toasts + leveled console, inline hints retired (2026-07-12)

Decided: the UI does NOT teach inline (that's a future, separate system). Two channels only:
- **Misuse/blocking feedback**: the pink miss flash (unbound keys, empty selection pull) and a
  new **panel toast column** (`toasts.tsx` — dismissible, deduped ×N, used SPARINGLY; the
  sanctioned cases: the invocation-gate shot failure, unbound-channel acts, no-turn acts,
  unreachable-page ink, wire errors).
- **Routine narration** → the console at a **logLevel control** ("quiet"|"info"|"debug",
  store.ts; log.ts prefixes `[aiui]`): state transitions, captures, binding flow. Read it via
  right-click panel → Inspect.
- Removed: every `turnStatus`/`captureStatus` inline line and the static "shots need
  invocation…" teaching footer.

CDP access facts (measured 2026-07-12): the side panel is an ordinary `page` target and the MV3
SW a `service_worker` target on the browser's debug endpoint — both fully drivable over raw CDP
(console read + evaluate proven live). The session's chrome-devtools MCP attaches to the
browser endpoint captured AT LAUNCH and does not follow browser relaunches (stale :52300 vs
live :52916 today) — reattach requires a new session or a browser that outlives it.

### 8. Known gaps / next (ordered)
1. LIVE verification with the user against the §13.6 tables (this file's checklist below).
2. `c` is hint-gated on inkOn; per model it should clear whenever strokes exist. Needs a
   hasStrokes fact mirrored panel-side (content knows). Small follow-up.
3. Tweak-state ring: steady (same as armed) for now — revisit if it confuses live.
4. Phase B kickoff: engine verbs (openTurn, send-keep-armed, stroke-no-open, onEvent
   unsubscribe, tab-switch event), PageSurface seam extraction, ink implementation
   convergence (overlay `Ink` vs `aiui-ink`).
5. Phase C: mount the modality; talk/share/region shots/jump/config/help arrive as ports.

## Live verification checklist (run with the user after every substantive change)

- [ ] disarmed: no border, page fully normal; ⌘B → border + turn open (panel shows turn).
- [ ] armed-no-turn (after Enter/Esc-cancel): border steady; ALL keys/pointer go to the page.
- [ ] in-turn: keys captured (typo → pink blip; s/a/i/c/d/t/Enter/Esc work); panel fields
      typeable.
- [ ] ink: i → draw (pointer claimed); i again → pointer back, strokes REMAIN; scroll → strokes
      follow the page; resize → strokes survive; tab away and back → still there; C → gone;
      disarm → gone.
- [ ] Enter mid-turn → sent turn lands in session; still armed (border stays).
- [ ] Esc mid-turn → turn cancelled, still armed; Esc again → goes to the page (not disarm).
- [ ] T mid-turn → page fully interactive (type + click), turn chips still in panel; ⌘B →
      same turn resumes (keys captured again).
- [ ] d mid-turn → everything gone (border off, ink cleared, turn dropped).
- [ ] shot flash on s; no page pill/badge anywhere; hints visible in panel only.
