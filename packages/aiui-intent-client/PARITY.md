# Parity ledger — nothing gets lost silently

Working checklist against
[docs/proposals/intent-client/04-parity-inventory.md](../../docs/proposals/intent-client/04-parity-inventory.md)
(the spec; it exists nowhere else). **Every row here ends in exactly one state: `done` (with
where), a phase assignment, or a `DECIDE` the owner has signed off on.** The Phase-5 gate walks
this file top to bottom; a row that is none of those blocks release. Update it in the same
commit as the code that moves it.

Status key: ✅ done · P2/P3/P4 = assigned phase · DECIDE = owner call needed (default noted).

## Machine (inventory §1A/§1C — the phase machine and modes)

| Row | Status | Where / when |
| --- | --- | --- |
| phase ladder disarmed·armed·turn·tweak; turn recovery via mirror | ✅ spec.ts (`phase`) — **recovery mirror P2** (wire lanes own the completeness-stamped mirror) |
| ⌘B idempotent grant-and-open; resume from tweak | ✅ spec.ts `cmdB` + tests |
| tweak: cap toggles out; page keys pass through in tweak | ✅ spec.ts `tweak` (toggle), keyRouting claim releases in tweak |
| send keeps armed (divergence 2) | ✅ spec.ts `send` + tests |
| Esc ladder: help → turn-cancel; never disarms | ✅ escOrder + escFloor + tests |
| disarm: ink off, everything abandoned; standing video kept | ✅ spec.ts `disarm` + excludes + tests |
| blip on unknown in-turn keys (swallow, 500 ms) | ✅ keys.ts verdict + panel blip line |
| `inkOn` standing/durable; only c/disarm clear strokes | ✅ spec.ts `ink` (durable) + `clear` verb — **stroke clearing itself P2/P3** (real page surface) |
| `videoOn`/`videoMode` standing/durable, agent-visible | ✅ spec.ts agent regions (single-writer bridge) |
| talk: hold (Space) vs hands-free (h); per-turn; Space-up ends only a hold | ✅ spec.ts `talk` region + excludes + tests |
| `micMuted` only while talking; reset on talk start | ✅ spec.ts + excludes + tests |
| help popup (`?`), Esc dismisses before cancel | ✅ spec.ts + panel help table |
| idle timeout closes turn → armed; suspended in tweak + while talking | ✅ `turnClosed` binding — **timer itself P2** (engine lane owns it; the suspension rule rides the lane config) |
| engine dual-truth (`engine.setArmed` beside phase) | ✅ designed out: the mode engine is the single truth; the wire Engine is DRIVEN (P2) |
| bus phase connected/connecting/closed; outage never touches phase | P2 — context fact `connected` exists; session bus + chip in the page work |
| `boundPort` + arm gate (arming requires bound) | P2 — gate becomes an `enabledWhen`/command guard on `connected` context |
| `uiScale` control (⌘+/⌘−/⌘0) | P2 — a `control()` + root font effect on the page |
| paint host (iPad) re-pointing | P4 (needs real capture host) — lane import unchanged |
| `inkTabId`/`leaderTabId`/`lastActiveTab` routing | ✅ context (`activeTab`/`grantedTab`) + claims re-point on tab switch |

## Config surface (inventory §1C controls — the "kept getting lost" list)

All of these are `control()`s (agent-visible via the standard tools) plus bar/config-strip
widgets, **declared and rendered now** (config.ts + caps.ts + panel.tsx); the lanes that READ
them bind in P2:

| Row | Status | Where / when |
| --- | --- | --- |
| `stt` transcriber choice (scribe-v2 default, 4 models) | ✅ control + config-strip select — **consumed at hello in P2** |
| `videoPeriodSec` (constant-mode s/frame, 1–10 slider) | ✅ control + slider revealed under video while constant — **sampler consumes in P2** |
| `linter` off/openai/gemini | ✅ control + strip select — **hello carries it in P2** |
| `inkVanish` + `inkFade` (2–20 s) | ✅ controls + toggle/slider under ink — **live re-relay in P2** |
| `shotFlash` / `logLevel` | ✅ controls (strip toggle/select) — **consumers in P2** |
| `uiScale` (⌘+/⌘−/⌘0, deliberately no widget) | ✅ control — **key bindings + root-font effect P2** |
| `rescanTick` | P2 (internal, with discovery) |
| engine choice + `pendingEngine` (applies at thread-close) | **P2** — control + deferred binding (the engine's `on:` bindings carry payloads for exactly this) |
| config strip (K layer) with session overrides / R reset / S save | **DECIDE** (default: adopt the overlay's session-layering in P2 as a strip pane; it was a "panel gap" the old client never closed) |
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
| smart-mode interaction gate (page pings arm one frame) | P2 — `interaction` PageEvent exists; sampler lane consumes it |
| capture pre-warm on arm (overlay 2A row) | DECIDE (default: keep the panel's turn-scoped warm; pre-warm-on-arm was overlay-only) |
| M10 warm-shot pixel path (36–48 ms) | P4 — `panel/capture.ts` copied nearly verbatim behind `CaptureSource` |
| M9 panel-document mic (grant persistence) | P2 (plain page = stable origin, same property) |
| manual shots flash; sampled frames never | P2 — `shotFlash` control + shot verb lane |
| standing mic/share between turns send NOTHING | ✅ structurally (talk per-turn exclude; sampling gated on turn) + P2 lane tests |

## Wire / lanes (Phase 2 proper)

Engine (`intent-pipeline`) + `composeIntent` · `createWire` (upload path) · `openIntentThread` ·
turn mirror recovery · talk lane (`createTalk`, worklet, PCM lifecycle incl. the
frames-chasing-closed-socket fix as a test) · VideoSampler over `CaptureSource` · preview pane ·
trace pane · connection chip · toasts · session bus + auto-bind (2 remembered keys) ·
channel-served page. Each imports unchanged (salvage list); what's new is binding them as
`IntentLanes` + claim appliers, each with a harness test.

## Hosts

| Row | Status |
| --- | --- |
| FakeBus | ✅ |
| CdpBus (real tabs, extension-free; refuse non-loopback CDP) | P3 |
| ExtensionBus + SW broker (copied) + content glue + static build + new identity + `aiui2.*` prefixes + never-both-armed policy | P4 |
| ⌘B via `chrome.commands` (in-page binding until then) | ✅ in-page (main.tsx) · P4 real |

## Bug ledger (inventory §3) as tests

F1/F2 families and engine-fix rows that are machine-shaped: ✅ client.test.ts (each `// ledger:`
comment names its incident). Lane-shaped rows (PCM chase, ElevenLabs include-list, stranded shot
veil, double-shot on fast S-drag, `blurIsSelfInflicted` first-screenshot drop, zoom restore,
reconnect check, stale-ring boot broadcast, replayed-armed GC) land with their lanes in
P2/P3/P4 — **each lane PR must move its rows from this line into its tests.**

## Known-open gaps carried from the old client (do not lose twice)

`c` hint gated on ink-mode not has-strokes (old PHASE-A gap 2) — P2 decides; tweak-ring appearance
unconfirmed live — P3; stt tier mappings unverified live — P2.

## Dropped (deliberate, owner-visible)

Overlay-only vscode/jump-picker mode: **DECIDE** (default: defer past P5; the overlay keeps it,
and the detached page gets it cheaply later via a `jump` ladder region if wanted).
