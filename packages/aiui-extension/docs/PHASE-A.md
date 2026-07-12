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
