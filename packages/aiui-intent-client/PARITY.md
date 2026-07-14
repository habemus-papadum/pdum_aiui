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
| `inkOn` standing/durable; only c/disarm clear strokes | ✅ spec.ts `ink` (durable) + `clear` verb; the real surface lands on real pages in P3 (cdp/page-ink.ts — InkSurface, document-anchored, live fade) — verified live by drawing on an https page |
| `videoOn`/`videoMode` standing/durable, agent-visible | ✅ spec.ts agent regions (single-writer bridge) |
| talk: ONE exclusive region (off/hold/handsFree), TWO affordances — hold Space or the press-and-hold 🎙 cap; the 🎧 toggle; per-turn; Space-up ends only a hold | ✅ spec.ts + caps.ts hold cap + tests |
| `micMuted` only while talking; reset on talk start | ✅ spec.ts + excludes + tests |
| help popup (`?`), Esc dismisses before cancel | ✅ spec.ts + panel help table |
| idle timeout closes turn → armed; suspended in tweak + while talking | ✅ `turnClosed` binding — **timer itself P2** (engine lane owns it; the suspension rule rides the lane config) |
| engine dual-truth (`engine.setArmed` beside phase) | ✅ designed out: lanes.ts DRIVES the wire Engine (setArmed/openTurn/send/stepOut verbs); its thread-close flows back as `turnClosed` |
| bus phase connected/connecting/closed; outage never touches phase | ✅ session.ts bus client (reconnect loop) → `connected` fact; the channel pill is the chip |
| `boundPort` + arm gate (arming requires bound) | P2 — gate becomes an `enabledWhen`/command guard on `connected` context |
| `uiScale` control (⌘+/⌘−/⌘0) | ✅ shell.tsx keys + `installUiScaleRoot` (ONE shared apply effect, both entries — the restore half pinned in shell.test); persisted via the config base; keys verified live in the side-panel document |
| paint host (iPad) re-pointing | **P5** — still open, and neither host supplies the fact: `paintClients` is a declared context field that nothing writes (spec.ts). The capture host it was waiting for now exists (P4), so this is a lane wiring job, not a blocked one |
| `inkTabId`/`leaderTabId`/`lastActiveTab` routing | ✅ context (`activeTab`/`grantedTab`) + claims re-point on tab switch |
| navigation events into the turn (same-tab SPA/reload; prompt-rendered) | ✅ `navigation` PageEvent → engine.navigation (lanes.ts + tests); real SPA navs land from the injected bootstrap (history wraps + popstate/hashchange) and full loads re-announce — seen live in the turn preview |
| tab-boundary events into the turn (switch names both sides) | ✅ onActiveTabChange + tabInfo → engine.navigation (lanes.ts + tests); the CdpBus's leader rule supplies it on real tabs |
| aiui-instrumented-page fact (`window.__AIUI__`) | ✅ `aiuiSupport` PageEvent → ctx.aiuiPage + the `page` pill; **real detection landed in P3** (the bootstrap's hello reports it — verified live: the `page` pill lit on an instrumented dev app and not on example.com). `locate` still stubbed (returns null) for the jump mode |
| jump-to-VS-Code mode (overlay-only; never in the old extension) | ANTICIPATED: seam + fact above; the `jump` ladder region + picker remain the post-P5 DECIDE |
| mic level meter while talking (the old HUD meter) | ✅ panel.tsx meter next to the pills (polls talk.level at display cadence) — **shows real levels once live talk is verified with a mic** |
| ring FOUR states (off · steady armed · breathing turn · **hollow = armed-but-ungranted**, owner 2026-07-14) | ✅ claim desire carries grant tab + hint; `ringForTab` projects per tab (shared by both buses); hollow renders outline + the activation hint, whose text is the LIVE `chrome.commands` binding (never hard-coded); client.test walks all four; extension-bus.test pins the projection + discovery |
| gate split: page acts (selection/clear/ink/keys) follow the tab in view; only pixels (shot/stream/sampling) follow the grant — and only while granted tab IS the tab in view (owner 2026-07-14) | ✅ spec.ts `available` + claims derives; client.test "a tab switch under MV3 darkens CAPTURE only" |

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
| config strip persistence | ✅ AUTO-SAVE (owner 2026-07-14, superseding the session-layering DECIDE): every control change persists on its own (debounced effect, config-store.ts `installConfigAutoSave`; store key `aiui2.config`); the save/reset verbs are gone |
| advanced raw-JSON config panel (G) | **DECIDE** (default: defer past P5 — agent `set_config` covers the need) |

## The segment editor (owner spec 2026-07-14 — new, never in the old client)

| Row | Status |
| --- | --- |
| fix ONE transcript segment in a popup; atoms move-whole-or-die; moves ignored, deletes = drop commands | ✅ ui/segment-editor.tsx (contenteditable island, atoms with exact identity via data-marker) + segment-editor.test |
| `segment-replace` + best-effort retiming; the pipeline reflows images | ✅ intent-pipeline segment-replace (multi-pass fold) + edit/retime.ts (wordDiff-anchored; kept words keep measured times) + tests both sides |
| paste text (plain / rich→Markdown) mid-segment and at the end of the turn | ✅ editor paste handler + edit/html-md.ts (best-effort converter, plain fallback) + append mode (`contribute`) |
| paste images mid-segment / at the end; lowered as "pasted image", never "screenshot" | ✅ shot `origin:"paste"` end to end (event → fold → `<pasted-image>`/text label) + synthetic takenAt anchoring; typed contributions keep arrival order (no talk window — honest limitation) |

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
| capture pre-warm on arm (overlay 2A row) | DECIDE (default: keep the panel's turn-scoped warm; pre-warm-on-arm was overlay-only). **Moot in the CDP tier**: `Page.captureScreenshot` needs no grant and no MediaStream, so there is nothing to warm — `holdStream` is a bookkeeping handle |
| M10 warm-shot pixel path (36–48 ms) | ✅ ext/capture.ts — the old panel's measured code, salvaged near-verbatim behind `CaptureSource`: SW mints the stream id, the panel document consumes it, JPEG 0.85, one warm stream per turn, `firstFrame` guards the black first paint. The CDP tier gets its pixels straight from the protocol instead |
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
| CdpBus (real tabs, extension-free; refuse non-loopback CDP) | ✅ cdp/{protocol,page-script,page-ink,cdp-bus}.ts + the sidecar's `/intent/cdp` bridge (cdp-proxy.ts) — **verified live**: ring · page keys · ink · shots on real tabs, including an https page, with no extension installed |
| ExtensionBus + SW broker (copied) + content glue + static build + new identity + `aiui2.*` prefixes + never-both-armed policy | ✅ ext/{extension-bus,sw,content,content-main,capture,panel,channel,protocol,manifest}.ts + scripts/build-ext.ts — **verified live** in the session browser: the extension loads at its pinned id, the worker registers, the content script serves every capability on a real tab, the panel boots with no console errors, discovers the channel through the native host and connects |
| activation shortcut via `chrome.commands` (in-page listener until then) | ✅ real: `aiui-intent-activate` (⌘B) + the toolbar action, both landing in the WORKER (they are the invocations that mint the `tabCapture` grant), broadcast to the panel — with a parked press the panel pulls on boot, because a panel opened BY the gesture missed the broadcast |

### What Phase 3 taught us (each row is a test)

| Live finding | Where it is pinned |
| --- | --- |
| Browser-level auto-attach ALSO adopts open tabs, so our adoption pass attached each page twice — two sessions, two tabs, and the second `addBinding` stole the first's reports | cdp-bus.test "one tab per page, however many times the browser attaches it" |
| A page carrying an older bootstrap went DEAF to a re-attaching panel (the install guard returned early, so it never said hello) | the versioned surface + `adopt()`; cdp-bus.test attach/hello rows |
| A reloaded page came back BARE while its session stayed healthy — ring, keys, ink gone, and no claim re-applies because the client's desire never changed | `Page.enable` + re-inject on `Page.frameNavigated` + the bus's sticky `replay`; cdp-bus.test reload rows |
| The leader tab followed FOCUS, and `document.hasFocus()` is false for every page whenever the browser app isn't frontmost — the turn ended up aimed at an `about:blank` | `relead()`: visibility leads, focus refines; cdp-bus.test "follows the tab you are LOOKING at" |
| Ink imported its module from the channel origin — silently blocked as MIXED CONTENT on every https page (the ring showed up; the ink didn't) | the sidecar bundles `/intent/page-ink.js`; the bus evaluates it INTO the page (`ensureInk`); cdp-bus.test "the page fetches nothing" |
| The trace pane's count read `engine.events.length` straight from the array — subscribing to nothing, and reading 0 through a live turn | panes.test "counts events as they arrive" |
| The bridge dropped the panel's first command (`ws` has no buffer before a listener attaches) — a bus that attaches to nothing | cdp-proxy.test "holding the commands it sends before the upstream opens" |
| Only the ⌘B gesture minted a capture grant, so arming from the BAR left shot/selection/clear dark forever (owner found it) — and the grant, once minted, stayed pinned to that tab, against the decided "CDP shots follow the active tab" | `CaptureSource.grantless` (the host says whether a grant is a real fact); client.test "the capture grant is the HOST's business, not a ritual" |

### Found in Phase 5 (open rows for the walk)

| Live finding | State |
| --- | --- |
| **Cross-TIER coexistence is unhandled**: the CDP client (plain page) and the extension client can drive the SAME tab at once — seen live while verifying the hollow ring (the CDP tier's stale solid ring rendered beneath the extension's hollow one; both tiers use the same ring element id, so they stack invisibly). The never-both-armed policy covers the frozen client only. Needs an owner decision: same refuse-to-arm treatment between our own tiers (detection via distinct ring ids / a marker attribute), or a "one client per channel session" rule upstream | **DECIDE + wire** |

### What Phase 4 taught us (each row is a test, or a structural answer)

| Live finding | Where it is pinned |
| --- | --- |
| `spec.available` was a HINT, not a gate: the bar dimmed an unavailable cap, and `dispatch` ran it anyway — so a key, an agent `control()` write, or a recovered turn could all walk straight through a gate the bar was honoring. Found by the coexistence row (never-both-armed), which the bar refused and the machine allowed | engine.ts `dispatch` consults `available` before every command; engine.test "REFUSES an unavailable command". Turn recovery was RELYING on the bypass (it re-armed with no channel) — it now waits for the channel to connect, in both entries |
| The panel bundle kept the LIBRARY build's externals, so the shipped page imported `@solidjs/web` as a bare specifier and died at boot — an extension page has no import map, and the failure is total (blank panel, one console line) | `configFile: false` in build-ext.ts, with the reason written down: an app build must inline exactly what a library build externalizes |
| The native host admitted ONE extension id, so a second client could never cold-start (an extension page cannot read its port off its own URL — that is the tax the plain page does not pay) | `allowed_origins` carries both ids (aiui/src/commands/extension.ts) + its test — this is what makes the greenfield client installable BESIDE the frozen one |
| Two extensions cannot both hold ⌘B (Chrome drops the second binding silently), so auto-loading the new client next to the frozen one would half-break both | **RESOLVED by the switchover (owner, 2026-07-14)**: launches now auto-load ONLY the intent client (`findIntentClientExtension` in aiui/util/chrome.ts); the owner removed the frozen extension from the session-browser profile by hand, and the DevTools-panel extension left the auto-load list too (the intent panel embeds its trace debugger). `pnpm -C packages/aiui-intent-client ext` remains the rebuild-into-running-browser loop |
| `tabCapture` really is invocation-gated — measured, not assumed: with no invocation the worker's `getMediaStreamId` refuses with "Extension has not been invoked for the current page" | `CaptureSource.grantless: false` for this host (extension-bus.test) — the grant is a world fact here, exactly as `grantless: true` says it is NOT one under CDP |

## Bug ledger (inventory §3) as tests

F1/F2 families and engine-fix rows that are machine-shaped: ✅ client.test.ts (each `// ledger:`
comment names its incident).

The extension-shaped rows are answered by the salvaged capture path and the new page footprint,
structurally rather than by a regression test (they need a real MediaStream to fail):
**stranded shot veil** — the flash element removes itself on a timer with no state to strand
(ext/content.ts); **first-screenshot black frame** — `firstFrame()` waits for a presented frame,
timeout-guarded (ext/capture.ts); **one stream per tab** — `holdTabStream` releases before it
re-holds, so a tab switch cannot leave two live captures. The `blurIsSelfInflicted` first-shot
drop is designed out: the page reports focus as a fact and nothing cancels on blur.

**Zoom restore** is done: the apply half is ONE shared effect (`installUiScaleRoot`, shell.tsx)
that fires with the restored value at boot — pinned in shell.test.tsx ("the saved scale must
LAND on the document"), and the keys verified live in the extension panel document (⌘+/⌘−/⌘0
stepped 100→120→110→100% over CDP-dispatched keystrokes, 2026-07-14).

Still lane-shaped and still open, to be moved into tests by the lane that lands them (P5):
PCM chase, ElevenLabs include-list, double-shot on fast S-drag, reconnect check,
stale-ring boot broadcast, replayed-armed GC.

## Preview / trace richness (owner check-in 2026-07-13 — minimal by design TODAY, rows so nothing is lost)

| Row | Status |
| --- | --- |
| turn preview = composeIntent rows (the literal lowering input) | ✅ ui/turn-preview.tsx — the overlay's full accumulator UX, LIVING IN THIS REPO as a first-class Solid component (owner 2026-07-14): shot thumbnails + hover peek + ✕ retraction through the wire engine's drop verbs; ⌖/⧉ selection pills with loc+text peeks; ⇢ navigation chips; PER-TURN RESET (no open thread renders nothing — the haunted-preview bug, pinned in panes.test) |
| word-DIFF flash as transcript deltas revise (the overlay's LiveDiffText, modal kit) | ✅ panes.tsx TurnPane — the overlay's keyed-`<For>` + LiveDiffText-island structure, ported onto the lanes cursor; appends never animate, revisions flash and settle (panes.test "a REVISION flashes the word-diff") |
| logprob confidence heat on finals (premium tier) | ✅ panes.tsx heat rows — per-word tint normalized against the TURN's own logprob range; the `:w` key suffix re-keys a row when its words arrive (the overlay's live lesson, kept as a comment + test) |
| rich trace viewer | ✅ ui/trace-pane.tsx `RichTracePane` — the shared debug-ui `TracesPane` (the SAME surface `/__aiui/debug` mounts: trace list, follow-newest, prompt hero, stage cards) embedded as a Solid island in BOTH entries; polls only while the disclosure is open. No rewrite needed — the owner authorized one, but the viewer was already mountable; nothing forked. **Verified live in the extension panel**: pulled the channel's list and live-followed a real trace |
| turn cap needs no grant (turn = wire concept; capture acts gate individually) | ✅ spec.ts available (found live: the grant gate dead-ended the bar) |

## Known-open gaps carried from the old client (do not lose twice)

`c` hint gated on ink-mode not has-strokes (old PHASE-A gap 2) — P2 decides; tweak-ring appearance
unconfirmed live — P3; stt tier mappings unverified live — P2.

## Dropped (deliberate, owner-visible)

Overlay-only vscode/jump-picker mode: **DECIDE** (default: defer past P5; the overlay keeps it,
and the detached page gets it cheaply later via a `jump` ladder region if wanted).

Tab-switch toast: **dropped** (owner 2026-07-14) — the hollow ring + hint carry the information
on the page itself; no panel toast on switch.
