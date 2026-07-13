# Parity ledger — nothing gets lost silently

Working checklist against
[docs/proposals/intent-client/04-parity-inventory.md](../../docs/proposals/intent-client/04-parity-inventory.md)
(the spec; it exists nowhere else). **Every row here ends in exactly one state: `done` (with
where), a phase assignment, or a `DECIDE` the owner has signed off on.** The Phase-5 gate walks
this file top to bottom; a row that is none of those blocks release. Update it in the same
commit as the code that moves it.

Status key: ✅ done · P2/P3/P4 = assigned phase · DECIDE = owner call needed (default noted).

The interaction contract itself (how these features behave) is [BEHAVIOR.md](./BEHAVIOR.md).

## Machine (inventory §1A/§1C — the phase machine and modes)

| Row | Status | Where / when |
| --- | --- | --- |
| phase ladder disarmed·armed·turn·tweak; turn recovery via mirror | ✅ spec.ts (`phase`); mirror = lanes.ts sessionStorageMirror + recover() (replay → wire re-dials → machine re-opens; grant re-asked via activation) — verified live across a reload |
| Activation (⌘B in the extension): idempotent grant-and-open; resume from tweak; NEVER cancels | ✅ activation.ts `activationGesture` (an imperative-boundary helper, not a command) + tests |
| tweak: cap toggles out; page keys pass through in tweak | ✅ spec.ts `tweak` (toggle), keyRouting claim releases in tweak |
| send keeps armed (divergence 2) | ✅ spec.ts `send` + tests |
| Esc ladder: help → tweak → turn-cancel → armed → disarmed (CONSCIOUS DEVIATION: the old client's Esc never disarmed; owner 2026-07-13 — step out of armed IS disarm) | ✅ escOrder, floorless ladder + tests |
| ONE hard disarmed: every route (esc, arm cap, d) clears ink; standing video kept | ✅ the `disarmed-is-hard` exclude + tests |
| blip on unknown in-turn keys (swallow, 500 ms) | ✅ keys.ts verdict + panel blip line |
| `inkOn` standing/durable; only c/disarm clear strokes | ✅ spec.ts `ink` (durable) + `clear` verb — **stroke clearing itself P2/P3** (real page surface) |
| `videoOn`/`videoMode` standing/durable, agent-visible | ✅ spec.ts agent regions (single-writer bridge) |
| talk: ONE exclusive region (off/hold/handsFree), TWO affordances — hold Space or the press-and-hold 🎙 cap; the 🎧 toggle; per-turn; Space-up ends only a hold | ✅ spec.ts + caps.ts hold cap + tests |
| `micMuted` only while talking; reset on talk start | ✅ spec.ts + excludes + tests |
| help popup (`?`), Esc dismisses before cancel | ✅ spec.ts + panel help table |
| idle timeout closes turn → armed; suspended in tweak + while talking | ✅ `turnClosed` binding — **timer itself P2** (engine lane owns it; the suspension rule rides the lane config) |
| engine dual-truth (`engine.setArmed` beside phase) | ✅ designed out: lanes.ts DRIVES the wire Engine (setArmed/openTurn/send/stepOut verbs); its thread-close flows back as `turnClosed` |
| bus phase connected/connecting/closed; outage never touches phase | ✅ session.ts bus client (reconnect loop) → `connected` fact; the channel pill is the chip |
| `boundPort` + arm gate (arming requires bound) | P2 — gate becomes an `enabledWhen`/command guard on `connected` context |
| `uiScale` control (⌘+/⌘−/⌘0) | ✅ main.tsx keys + root-font effect; persisted via the config base |
| paint host (iPad) re-pointing | P4 (needs real capture host) — lane import unchanged |
| `inkTabId`/`leaderTabId`/`lastActiveTab` routing | ✅ context (`activeTab`/`grantedTab`) + claims re-point on tab switch |
| navigation events into the turn (same-tab SPA/reload; prompt-rendered) | ✅ `navigation` PageEvent → engine.navigation (lanes.ts + tests) — **full SPA turn-continuity semantics later, with real pages (P3)** |
| tab-boundary events into the turn (switch names both sides) | ✅ onActiveTabChange + tabInfo → engine.navigation (lanes.ts + tests) |
| aiui-instrumented-page fact (`window.__AIUI__`) | ✅ `aiuiSupport` PageEvent → ctx.aiuiPage + the `page` pill; `locate` in PageCapability — **real detection rides the P3/P4 page hosts** |
| jump-to-VS-Code mode (overlay-only; never in the old extension) | ANTICIPATED: seam + fact above; the `jump` ladder region + picker remain the post-P5 DECIDE |
| mic level meter while talking (the old HUD meter) | ✅ panel.tsx meter next to the pills (polls talk.level at display cadence) — **shows real levels once live talk is verified with a mic** |
| ring three states (off · steady armed · breathing turn) | ✅ claim desire carries them; test walks all three; the ring pill shows off/on/live — **page-side rendering with the P3/P4 hosts** |

## Config surface (inventory §1C controls — the "kept getting lost" list)

All of these are `control()`s (agent-visible via the standard tools) plus bar/config-strip
widgets, **declared and rendered now** (config.ts + caps.ts + panel.tsx); the lanes that READ
them bind in P2:

| Row | Status | Where / when |
| --- | --- | --- |
| `stt` transcriber choice (scribe-v2 default, 4 models) | ✅ control + strip select; **consumed**: panelIntentConfig → the hello's `meta.intent` (lanes.test) |
| `videoPeriodSec` (constant-mode s/frame, 1–10 slider) | ✅ control + slider; **consumed**: the frame pump's intervalMs reads it per tick (lanes.ts) |
| `linter` off/openai/gemini | ✅ control + strip select; **consumed**: rides the hello via panelIntentConfig |
| `inkVanish` + `inkFade` (2–20 s) | ✅ controls + widgets; **consumed**: the ink claim's fadeSec + the live re-relay effect (lanes.bind) |
| `shotFlash` / `logLevel` | ✅ controls; shotFlash **consumed** (manual shots flash, sampled never — lanes.test); logLevel consumer pending with the console channel |
| `uiScale` (⌘+/⌘−/⌘0, deliberately no widget) | ✅ control + keys + root-font effect (main.tsx) |
| `rescanTick` | P2 (internal, with discovery) |
| engine choice + `pendingEngine` (applies at thread-close) | **P2** — control + deferred binding (the engine's `on:` bindings carry payloads for exactly this) |
| config strip with session overrides / reset / save | ✅ config-store.ts (live values = session; saved base in localStorage under `aiui2.config`; save flushes first — the M2 boundary) + strip buttons |
| advanced raw-JSON config panel (G) | **DECIDE** (default: defer past P5 — agent `set_config` covers the need) |

## The bar + status pills (owner review 2026-07-13 — conscious divergence, improvement)

| Row | Status |
| --- | --- |
| Bar is a TREE flattened into depth rows (arm · step out · help at root; tiers reveal as parents engage) | ✅ modal/bar.ts + caps.ts |
| Enabled DERIVED (engine canDispatch dry-run; spec.available for verbs/gates) | ✅ modal/engine.ts |
| Stable cap labels (lit carries engagement; no relayout) | ✅ caps.ts + keys.ts hints |
| Arm cap = armed status + toggle (gated on channel; mid-turn press = full abandon, no confirm) | ✅ spec.ts `arm` |
| Status pills: channel · mic grant · REC (talk/muted) · stream · video · ink · keys · iPad | ✅ panel.tsx — mic/iPad facts are context now, **real suppliers P2 (talk lane) / P2-paint** |

## Operations (inventory §2 — claims)

| Row | Status | Where / when |
| --- | --- | --- |
| ink pointer / tab stream / video sampling / key routing / ring | ✅ claims.ts over the host seam + harness tests |
| smart-mode interaction gate (page pings arm one frame) | ✅ the frame pump's shouldCapture/rearm over `interaction` PageEvents (lanes.ts + test) |
| capture pre-warm on arm (overlay 2A row) | DECIDE (default: keep the panel's turn-scoped warm; pre-warm-on-arm was overlay-only) |
| M10 warm-shot pixel path (36–48 ms) | P4 — `panel/capture.ts` copied nearly verbatim behind `CaptureSource` |
| M9 panel-document mic (grant persistence) | P2 (plain page = stable origin, same property) |
| manual shots flash; sampled frames never | ✅ lanes.ts takeShot (flash AFTER grab) + pump sendFrame (never) — lanes.test rows |
| standing mic/share between turns send NOTHING | ✅ structurally (talk per-turn exclude; sampling gated on turn) + P2 lane tests |

## Wire / lanes (Phase 2 proper)

**Done in the first P2 tranche** (lanes.ts, session.ts; harness rows in lanes.test.ts; verified
live against a running channel — thread dialed, events flushed, cancel clean): Engine +
composeIntent bound; createWire + openIntentThread (finalize on send, cancel otherwise;
lowered-prompt echo + channel-error toasts); createTalk + SpeechPlayer composed (mic lives in
the panel document — M9); the VideoSampler frame pump as the real videoSample applier; session
bus + /health probe + port resolution (explicit → ?channel= → same-origin). **Remaining:**

Engine (`intent-pipeline`) + `composeIntent` · `createWire` (upload path) · `openIntentThread` ·
talk PCM lifecycle live-verified (worklet mic; the frames-chasing-closed-socket
fix as a test — needs the owner's mic). Preview/trace panes, turn mirror, uiScale,
and the session-layering strip landed in the second tranche (panes.tsx,
config-store.ts); the CHANNEL-SERVED page landed in the third: src/sidecar.ts
(vite middleware under /intent/, registered always-on in the aiui CLI — takes
effect on the next `aiui claude` launch; the page's same-origin discovery then
needs no ?channel=).

## Hosts

| Row | Status |
| --- | --- |
| FakeBus | ✅ |
| CdpBus (real tabs, extension-free; refuse non-loopback CDP) | P3 |
| ExtensionBus + SW broker (copied) + content glue + static build + new identity + `aiui2.*` prefixes + never-both-armed policy | P4 |
| activation shortcut via `chrome.commands` (in-page listener until then) | ✅ in-page listener → activationGesture (main.tsx) · P4 real |

## Bug ledger (inventory §3) as tests

F1/F2 families and engine-fix rows that are machine-shaped: ✅ client.test.ts (each `// ledger:`
comment names its incident). Lane-shaped rows (PCM chase, ElevenLabs include-list, stranded shot
veil, double-shot on fast S-drag, `blurIsSelfInflicted` first-screenshot drop, zoom restore,
reconnect check, stale-ring boot broadcast, replayed-armed GC) land with their lanes in
P2/P3/P4 — **each lane PR must move its rows from this line into its tests.**

## Preview / trace richness (owner check-in 2026-07-13 — minimal by design TODAY, rows so nothing is lost)

| Row | Status |
| --- | --- |
| turn preview = composeIntent rows (the literal lowering input) | ✅ panes.tsx |
| word-DIFF flash as transcript deltas revise (the overlay's LiveDiffText, modal kit) | **P2-polish** — import `LiveDiffText`/`wordDiff` from the kit; wire to transcript-delta events |
| logprob confidence heat on finals (premium tier) | **P2-polish** — the events carry logprobs; render heat in the preview rows |
| rich trace viewer | **DECIDE** (default: the panel's raw pane stays; LINK OUT to the channel's own `/debug` viewer, which already renders traces — same origin now) |
| turn cap needs no grant (turn = wire concept; capture acts gate individually) | ✅ spec.ts available (found live: the grant gate dead-ended the bar) |

## Known-open gaps carried from the old client (do not lose twice)

`c` hint gated on ink-mode not has-strokes (old PHASE-A gap 2) — P2 decides; tweak-ring appearance
unconfirmed live — P3; stt tier mappings unverified live — P2.

## Dropped (deliberate, owner-visible)

Overlay-only vscode/jump-picker mode: **DECIDE** (default: defer past P5; the overlay keeps it,
and the detached page gets it cheaply later via a `jump` ladder region if wanted).
