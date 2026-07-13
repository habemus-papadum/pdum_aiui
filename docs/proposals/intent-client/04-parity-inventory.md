# Parity inventory: every mode, claim, and mode-bug in the two clients

Part of the [intent-client plan](./README.md). Compiled 2026-07-13 by a line-level audit of
both conductors at `bbd9fff`/`8b43d16`; all cites verified then. **Purpose: the parity
checklist and regression-spec for the greenfield client
([README](./README.md), "The strategy").** A rebuild is done when every row here is either implemented,
consciously diverged (extend the §13.6 ledger), or consciously dropped (say so).

"Engine" = the shared `intent-pipeline/engine.ts` `Engine`, instantiated by both hosts.

## 1A · Engine state (shared class — note the hosts drive it differently)

| name | value | changed by | relations / exit | lifecycle · durable | site |
| --- | --- | --- | --- | --- | --- |
| `armed` | bool | overlay: backtick/✳/session-bus/agent; panel: dual-written beside `phase` (`main.tsx:957,971,1000`) | overlay `send()` disarms; panel send keeps armed (divergence 2) | standing · no | `engine.ts:36,100-115` |
| `mode` (`ink`\|`tweak`\|`vscode`) | enum | overlay T/J dispatch, `stepOut` | Esc→ink; disarm resets | per-arm · no | `engine.ts:37,131-137` |
| `talking` | bool | talkStart/End (Space-hold, h) | gated on armed; send/cancel/disarm/blur end it | per-turn · no | `engine.ts:38,389-413` |
| `threadOpen` | bool | overlay: implicit on first act; panel: explicit `openTurn()` only (divergence 1) | send/cancel/timeout close | per-turn · mirrored | `engine.ts:39,171-181` |
| idle timeout (`autoEndSec`) | policy | bumped per emit | **suspended** in tweak/vscode + while talking | per-turn · config | `engine.ts:364-383` |
| `config.submode` | `transcription`\|`realtime` | config/hello | gates PCM streaming | standing · persisted | `config.ts:182`, `talk.ts:108-119` |

## 1B · Overlay modes/flags (`aiui-dev-overlay`)

| name | value | changed by | relations / exit | lifecycle · durable | projection | site |
| --- | --- | --- | --- | --- | --- | --- |
| **`UiMode`** off·ready·composing·shooting·talking·tweaking·vscode | **derived** enum(7) | pure fn of {armed, mode, talking, threadOpen, shooting} | precedence tweak/vscode > shooting > talking > composing > ready > off | derived, never stored | pill `data-ui-mode`, ring, cursor, `report().uiMode` | `ui-mode.ts:27-76` |
| `shooting` (shot veil) | bool | D down/up, `cancelShot` | ink mode only; blur/guard cancels | transient | crosshair veil, ring | `capture.ts:233-262` |
| `sharing` (screen share) | bool | V (ink only) | bounded by turn; guard stops | standing-within-turn | ● video badge, 🦉/🔫, fps slider | `capture.ts:281-348` |
| share `videoMuted` | bool | N | only while sharing; reset on toggle-on | per-share | badge `.muted`, 👁/🙈 | `capture.ts:179-231` |
| sampler `paused` | bool | window blur/focus | internal to share | transient | — | `video.ts:148,207-220` |
| `micMuted` | bool | M | only while talking; reset on talkStart | transient | 🔇 badge, cold meter | `talk.ts:148-156` |
| `mainListening` | bool | Space/H | drives `talking` | per-window | (via talking) | `talk.ts:138-175` |
| ink fade ✒️/💨 | 0 or 2–8 s | chip, slider, config | permanent ⇒ only C clears | config | chip + slider | `modality.ts:483-514,736-751` |
| `videoMode` 🦉/🔫 | smart\|continuous | vmode toggle, config | smart = interaction-gated | config · localStorage | button | `types.ts:125`; `modality.ts:533-542` |
| `videoFrameIntervalMs` | 500–10000 | fps slider (5 steps) | shown while sharing | config · localStorage | slider | `modality.ts:518-528` |
| `linter` | off\|openai\|gemini | L in strip; agent | orthogonal to transcriber | config · localStorage | strip chip, 💡 | `modality.ts:971-983` |
| config strip open | bool (K **layer**) | K / Esc / Enter | can't outlive arm; not in tweak/vscode | transient | strip above HUD | `config-strip.tsx:181-192` |
| `pendingEngine` | number? | strip digit while threadOpen | **applies at thread-close** | pending | "→ … when this thread closes" | `modality.ts:943,1001-1013` |
| `sessionOverrides` | Partial config | strip edits | layered above persisted; R reset / S save | per-page-session | "session — unsaved" | `modality.ts:939-945,1015-1031` |
| advanced config panel | open | G/gear | raw-JSON editor | transient | JSON panel | `modality.ts:1032-1036` |
| jump picker open | bool (**layer**) | vscode dbl-click; armed ⇧-click | any mode≠tweak; Esc closes | transient | picker + bbox | `modality.ts:884-913,1089-1124` |
| help panel | open | H / ? | keymap table | transient | widget body | `modality.ts:1095-1103` |
| widget panel open | bool | expander/H/tab/agent | — | transient | unfolds above pill | `widget.tsx:264,429-457` |
| `hudClaimed` | bool | `claimHudSlot` | hides "✳ aiui" label | mount-lifetime | pill slot | `widget.tsx:284,436` |
| active modality tab | index | tab click | ≥2 labels → tab row | standing | tab class | `widget.tsx:352-363` |
| remote-paint armed (iPad) | via setArmed | iPad instrumentation | forces armed + mode=ink | iPad-driven | ink strokes | `modality.ts:265-311` |
| speaker/`audioBack` 🔊 | label? | server `speech` | gated on mute; barge-in | transient | 🔊 slot | `modality.ts:551-562` |
| `talkMode` hold\|toggle | enum — **RETIRED** | config only | schema validity only | config | — | `keymap.ts:84-86` |

## 1C · Panel modes/flags (`aiui-extension`)

| name | value | changed by | relations / exit | lifecycle · durable | projection | site |
| --- | --- | --- | --- | --- | --- | --- |
| **`phase`** disarmed·armed·turn·tweak | liveSignal enum(4) | ⌘B; Esc/d/Enter/T dispatch; pills; engine-close; boot recovery | THE machine; **separate from engine.mode** (tweak is a phase; engine.mode stays "ink", `main.tsx:1094`) | standing · turn recovered via mirror | armed/turn pills, tweak banner, ring | `main.tsx:670-671,880-1031` |
| `blip` (rejected key) | string? | `ignored` verdict | in-turn only; 500 ms timeout | transient | blip line + page miss-flash | `main.tsx:673-674,1114-1128` |
| `inkOn` | liveSignal + durable | `i`; disarm→false | standing (div. 3); pointer claim derived; disarm clears (div. 5) | standing · `durableSignal("panel.inkMode")` | `i` cap lit; offers `c` | `main.tsx:314-319,417-422` |
| `videoOnLive` | liveSignal + control | `v` | sampling claim derived | standing · control | `v` cap | `main.tsx:711,1065-1072`; `store.ts:69` |
| `videoModeLive` smart\|constant | liveSignal + control | `f` | drives sampler interval + gate | standing · control | `f` cap | `main.tsx:712,1074-1080`; `store.ts:73` |
| `listeningIsHold` | bool | Space-hold vs `h` | Space-up ends only a hold | per-window | `␣`/`h` cap | `main.tsx:294,1039-1059` |
| talk listening/micMuted | shared shell | Space/h/m | m only while listening; leavePhaseTurn stops | per-turn | REC meter, `m` cap | `main.tsx:1039-1064` |
| `selectionPresent` | liveSignal | content-script pings | affordance only (pull model) | live | `a` cap dot | `main.tsx:225,553-556` |
| `helpOpen` | bool | `?`; Esc layer | Esc dismisses **before** cancel rung | transient | keys popup | `main.tsx:700,1034-1037,1141-1145` |
| bus phase | connected\|connecting\|closed | re-dial timer | outage never touches `phase` | standing · session+local | chip dot | `session.ts:50-149` |
| `boundPort` | liveSignal number? | connect/disconnect/auto-bind | arming requires bound | standing · 2 remembered keys | chip label; arm gate `main.tsx:941-947` | `session.ts:56,80-109` |
| paint host (iPad) | port? | `paint.sync()` on binding change | iPad arm → `openTurn` | standing | frames to iPad | `paint.ts:44-121`; `main.tsx:788-811` |
| `inkTabId`/`leaderTabId`/`lastActiveTab` | tab ids | activation, `pointCaptureAt` | routing; tab switch re-points | standing | — | `main.tsx:321,325,676,851-862` |
| `uiScale` | control 0.6–2 | ⌘+/⌘−/⌘0 | registered before leader (wins mid-turn) | standing · `chrome.storage.local` | root font % | `main.tsx:1153-1197` |
| `inkVanish`+`inkFade` | control bool + 2–20 s | config bar | live re-relay while inked | standing · control | bar + fade relay | `main.tsx:1310-1317,1397-1418` |
| `stt`/`linter`/`videoPeriodSec` | controls | config bar | read at thread-open (hello) | standing · control | bar | `store.ts:59-76` |
| `shotFlash`/`logLevel`/`rescanTick` | controls | agent/internal | manual-shot flash gate | standing | — | `store.ts:34-51` |

**Panel gaps vs overlay** (divergences to re-decide, not accidents to copy): no vscode/jump
mode, no config strip / session layering / advanced JSON editor, help is `?` not H.

## 1D · Keymap layer stacks (both on `aiui-viz/modal` keys.ts — different grammar)

| host | stack (top-down) | fallback | site |
| --- | --- | --- | --- |
| overlay | arm · config-strip · jump-picker · tweak · vscode · armed | all **pass** (page keeps unclaimed keys) | `keymap.ts:171-487` |
| panel | single `turn` layer (`phase === "turn"`) | **swallow** (wholesale claim; unknown → blip) | `leader.ts:139-281` |

Overlay's arm key is handled *outside* the stack (`modality.ts:1544-1583`); the panel's ⌘B is
`chrome.commands`, not in the stack.

## 2 · Claims (derived side effects)

### 2A · Overlay — automatic (kit reconciler, per event, `modality.ts:600-710`)

| claim | derivation → action | site |
| --- | --- | --- |
| shot-veil guard | `shooting && (!armed \|\| mode≠ink)` ⇒ cancel | `:600-613` |
| share bound-by-turn | `sharing && (!armed \|\| !threadOpen)` ⇒ stop | `:614-623` |
| capture pre-warm | `armed` ⇒ warm grant | `:624-642` |
| config-strip visibility | `uiMode==="off"` ⇒ hide | `:644-654` |
| jump-picker visibility | off\|tweaking ⇒ hide | `:656-667` |
| cursor | mode table column | `:668-678` |
| mode ring | `ctx.setUiMode(mode)` | `:679-690` |
| ink pointer routing | mode ∈ {ready, composing, talking} | `:691-698` |
| preview visibility | mode ≠ off | `:699-704` |
| blur-exit | `blurExitTarget(TABLE, mode)` ⇒ `stepOut` | `:837-841` |
| smart-share gate | continuous \|\| interacted() per tick | `capture.ts:206-217` |

### 2B · Panel — hand-called (the F2 footgun; def → call sites)

| claim | derivation | def | call sites |
| --- | --- | --- | --- |
| ink pointer | `phase==="turn" && inkOn()` @ live tab | `main.tsx:366-388` | `:419,621,890,908,1018` (+fade `:1313`) |
| tab stream (warm capture) | `phase==="turn" && tabId` | `:337-356` | `:622,891,909,1020` |
| video sampling | `phase==="turn" && videoOnLive` | `:763-770` | `:892,910,1069` |
| key-capture routing | phase ∈ {turn, tweak} → active tab | `:851-862` | `:884,906,1016,1258,619` |
| ring broadcast | on = phase≠disarmed; turn-tone = phase ∈ {turn, tweak} | `:494-512` | `:893,903,959,977,1267,1291` (+hello `:1250`) |
| island sync (caps/preview/blip) | `leaderState()`, helpOpen, blip | `:703-706` | ~15 sites |

Plus two more hand-written derivation spots: `leaderState()` (`main.tsx:678-687`) and the
engine-close→phase reconciliation (`:520-535`). In the greenfield all of 2B become engine
claims; 2A's table is the reference discipline.

## 3 · Mode-bug ledger (the acceptance-test source)

F1 — Solid write-batching, stale same-flow reads (7+): ring one state behind; disarm stomped
back to armed; ink cap inverted; selection cap stuck lit; key blip; zoom restore
(`cedf60e`); channel reconnect check; video/fps caps inverted **after** liveSignal existed
(`10c1522`).

F2 — forgotten island sync (3+): caps stale after selection change; blip line stale; "command
bar completely missing" (initial `hidden=true`, no sync path cleared it).

Engine/mode fixes (each a test row): stuck `talking` outlived its thread (gesture flushed to
the void); send-as-cancel (`keepArmed` divergence); stranded shot veil (fixed by
reconciliation, not transition bookkeeping); first screenshot dropped hands-free (every
`getDisplayMedia` blurs — `blurIsSelfInflicted`); region+viewport double-shot on fast S-drag;
held-Space repeats scrolled the page during async mic acquisition (the `swallow` verdict);
ink kept drawing in tweak; ink evaporated on send (now only C/disarm clear); idle-timeout
killed turns during tweak/vscode (timer suspended); PCM frames chased a closing socket;
ElevenLabs 0-byte commits (include-list → exclusion rewrite); state died at every navigation
(page-hello re-sync); ⌘B-as-escape silently abandoned turns (now idempotent); stale ring lit
forever by a dead panel document (boot broadcast); a fresh page's replayed `armed` GC'd
another page's recoverable turn.

Known open gaps (pre-existing): `c` hint gated on ink-mode not has-strokes; tweak-ring
appearance unconfirmed live; most stt tier mappings unverified live.
