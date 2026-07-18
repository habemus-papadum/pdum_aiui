# Components and reuse: one core, many hosts

Part of the [intent-client plan](./README.md). This document answers "have we architected the
pieces of the extension sufficiently well?" — what is genuinely shared, what got reinvented and
why, how coupled the panel is to its host, and the target component map.

## 1 · The finding that reframes the question

The extension does **not** reinvent lane code. The shared surface is broad and fork-free:
Engine + `composeIntent`, the wire (`createWire` — the panel's hand-rolled twin was *deleted*
when it adopted the shared one, PHASE-C-PLAN:184-186), `openIntentThread`, the talk lanes
(`createTalk`, worklet source), `VideoSampler`, Preview/CheatSheet/KeymapHelp, the trace pane,
the indicator ring, the relay, the ink surface (`aiui-ink`), and the paint host (`aiui-paint`) —
all imported, none forked (STATUS.md:117-120). During panel development the overlay's 645 tests
never broke.

What got duplicated is the layer *above* the lanes — and this was not drift, it was a **missed
architectural step that the plan itself records**. Proposal §13.6 Phase C
(browser-extension-intent-tool.md:566-576) and PHASE-C-PLAN §0 called for the panel to
implement `IntentToolContext` and **mount `modality.ts` verbatim** — *"ported, not
reimplemented."* That mount never happened. The panel re-composed the same shells behind a
parallel orchestrator (`main.tsx`), so today there are two conductors:

- `aiui-dev-overlay/src/multimodal/modality.ts` — 1,597 lines, one function;
- `aiui-extension/src/panel/main.tsx` — 1,480 lines, one component.

The irony documented by the bug ledger: the overlay's conductor already uses the modal kit's
discipline — a single derived `uiMode()` (modality.ts:586-593) and a `createReconciler` that
re-asserts every surface after every event (*"one missed transition costs a frame, not a wedged
UI"*, modality.ts:595-599). The panel has neither: five hand-called `sync*` functions with "no
enforcement" (STATUS.md:62), six sites that mutate `phase`
(`enterPhaseTurn`/`leavePhaseTurn`/`disarm`/`leaderDispatch`/`armOnly`/`engine.onEvent`), and
the F1/F2 regression families as the receipts. **The panel reinvented the one part of the
overlay that was load-bearing for correctness, and skipped the two mechanisms that made the
overlay stable.**

So the owner's perception — "constantly reinventing rather than reusing" — is precise one level
up from where it looks: components shared, **composition duplicated**. The
[mode engine](./01-mode-engine.md) is the answer to that layer; this document covers what to do
with everything around it.

## 2 · Component-by-component verdicts

Verdict key: **SHARED** (imported, zero fork) · **WRAPPED** (shared core + host shim) ·
**REINVENTED** (parallel implementation) · **DIVERGED** (deliberately different behavior —
legitimate only while the §13.6 divergence ledger says so).

| Concern (owner's list) | Where it lives | Verdict | chrome.* it genuinely needs |
| --- | --- | --- | --- |
| (a) media permission acquisition | `sw.ts:52-118` (mints `tabCapture.getMediaStreamId` — the **only privileged act**), `panel/capture.ts:69-97` consumes via standard `getUserMedia` | WRAPPED, cleanly — the panel side takes an **injected** `mintStreamId` (capture.ts:70-77) | `tabCapture` (SW), `action.onClicked`+`commands.onCommand` invocation gate, `sidePanel.open` |
| (b) pushing raw captures efficiently | `panel/capture.ts:114-164` (M10: warm stream → `drawImage`/`toBlob` → bytes straight to `wire.uploadAttachment`) | SHARED push path; local pixel path is already host-agnostic | none |
| (c) key interception/redirection | `content.ts:164-205`, panel dispatch `main.tsx:851-862,1130-1236` | REINVENTED grammar (`leader.ts`) on the SHARED modal kit resolver | runtime/tabs messaging (relay) |
| (d) inking | surface SHARED (`aiui-ink`, `content.ts:42-141`); claim logic local (`main.tsx:314-422`) | SHARED + DIVERGED by config (document-anchored, C/disarm-only clears — ledger #4, #5) | tabs messaging |
| (e) on-page indicator | ring SHARED (`aiui-webext`, `content.ts:40`); broadcast local (`main.tsx:494-512`) | SHARED; ~30 local LOC | `tabs.query`/`sendMessage` |
| (f) modal logic | `main.tsx:670-1031` (§13.6 machine) | **REINVENTED** — the missed `modality.ts` mount | none intrinsic |
| (g) command logic | `leader.ts` (398 LOC, pure, table-tested), caps `keys-view.tsx`, config bar `main.tsx:1363-1419` | grammar DIVERGED (ledger #6, #8) on shared kit; config strip REINVENTED-thinner (no session layering, no agent `set_config`) | none (pure) |
| (h) compilation engine | `main.tsx:220,914-916`, `turn.ts:21-42` | **SHARED** | none |
| (i) wire/events/fold/debug | wire SHARED (`main.tsx:250-288`); trace pane SHARED; turn mirror REINVENTED (`turn.ts:55-77`, storage.session vs the overlay's sessionStorage); session bus REINVENTED (`bus.ts` — but pure WebSocket, no chrome) | mixed | `storage.session/local` only |
| (j) iPad paint | host SHARED (`aiui-paint`); `paint.ts` (122 LOC) injects **every** host effect, zero chrome.* | WRAPPED, cleanly | none in paint.ts |

Two model citizens worth naming, because they prove the pattern works in this codebase:
`panel/capture.ts` (host effects injected, pixel path pure) and `paint.ts` (every effect
injected). Two subsystems already did the seam correctly; the rest of the panel didn't.

## 3 · Host-coupling: the numbers

From the audit of every `chrome.*` call site (non-test src ≈ 4,200 LOC):

| Bucket | LOC | Contents |
| --- | --- | --- |
| **PURE** — runs unchanged in a plain page | ~1,205 | `leader.ts` 398, `keys-view.tsx` 164, `bus.ts` 148 (WebSocket, zero chrome), `turn-pane` 103, `connection-chip` 95, `preview-pane` 90, `store.ts` 87, `toasts` 65, … |
| **RELAY-ONLY** — loopback fetch / injected callbacks / `relayRequest*` | ~442 | `panel/capture.ts` 185, `paint.ts` 122, `graph.ts` 76, `trace-pane.tsx` 59 |
| **CHROME-BOUND** | ~2,557 | `main.tsx` 1,480 (via only **20 inline call sites**), `content.ts` 340 (content-script world by nature), `session.ts` 150, `boot.ts` 150 (already injectable + tested), `sw.ts` 141 (the privileged broker), `channel.ts` 134, `tools-link.ts` 85, `turn.ts` 77 |

Read the third row carefully: `main.tsx` is chrome-bound **through twenty inline sites** —
`tabs.query` in `activeTabId`/`activeTabMeta`/`addSelection`/`takeShot`/`broadcastRing`/boot,
inline `tabs.sendMessage`, inline `tabs.onActivated`, three inline `runtime.onMessage`
listeners, inline `storage` for uiScale — all **bypassing** the seam that already exists:
`aiui-webext/relay.ts` is pure codecs plus three thin chrome wrappers (relay.ts:30-57, 70-126),
and every tab-scoped page capability (`ink`/`keylayer`/`flash`/`selection`/`viewport`) already
flows through `relayRequestTab` (12 sites). The transport interface is ~80 % built; the panel
just didn't finish routing through it.

**Conclusion: the host coupling is shallow.** Swapping hosts = reimplementing three relay
functions + a tabs/windows/storage facade (~15 small methods), not rewriting subsystems. This
is what makes the [detached harness](./03-hosts-and-dev-loop.md) cheap.

## 4 · Testability

Eight headless test files exist and they cover exactly the pure leaves: the leader grammar
(table-driven), discovery cells (with a 3-call chrome stub), boot watchdog (injected seams),
bus reducer, channel helpers, manifest, worklet bytes. **Coverage is inverted relative to
risk** (STATUS.md:111-115): the brain — where the bar-hidden bug, both cap inversions, and
send-as-cancel all lived — has zero tests, and each of those "was findable by a jsdom test that
drives `leaderDispatch` and asserts the islands' DOM."

Why the brain is untestable today (all four must fall):
1. everything lives inside one `Panel()` closure run by `render()` (`main.tsx:196,1477-1480`);
2. no single transition function — phase mutates at six sites;
3. chrome.* called inline (the 20 sites), not injected;
4. the shells are constructed inside `Panel()` with chrome-coupled thunks.

And the E2E route is **platform-blocked**, not merely unbuilt: an extension page in a
CDP-created tab never commits (`readyState` stays `"loading"` — measured, DEBUGGING.md:108-122);
the chrome-devtools MCP cannot reach the SW and its attach freezes at launch
(DEBUGGING.md:124-135). Neither headless nor CDP nor MCP can exercise the orchestration today.
This is the strongest single argument for the harness: it is not a nice-to-have, it is the
**only** route to an agent-verifiable panel.

The harness fake-surface is small and enumerated (the audit lists it exhaustively): a tabs/
windows/storage facade, the three relay functions, `mintStreamId`/`grabShot` injection, and the
engine driven as-is. `bus.ts` needs nothing — it is already pure.

## 5 · The target component map

```
┌─────────────────────────────────────────────────────────────────────┐
│  intent-client core (host-agnostic, headless-testable)              │
│                                                                      │
│   mode engine: spec + reducer + claims     ← 01-mode-engine.md       │
│   turn/wire orchestration (engine events ↔ commands)                │
│   projections: bar model · keymap help · control bridge · trace      │
│   (today: split across modality.ts and main.tsx, duplicated)         │
└──────────────┬──────────────────────────────────────┬───────────────┘
               │ PageBus (keys·ink·ring·selection·    │ CaptureSource
               │          viewport — relay.ts codecs) │ (frames·shots·mic)
   ┌───────────┴───────────┐              ┌───────────┴───────────┐
   │ ExtensionBus (MV3)    │              │ tabCapture (SW mint)  │  ← prod
   │ CdpBus (harness)      │              │ getDisplayMedia       │  ← overlay
   │ InPageBus (overlay)   │              │ CDP screencast        │  ← harness
   │ FakeBus (tests)       │              │ Fake frames           │  ← tests
   └───────────────────────┘              └───────────────────────┘
```

The lanes stay where they are — they are already shared. What moves:

- **Conductor logic** leaves `main.tsx` and (during its Solid port) `modality.ts`, into the
  core — as mode-engine spec + claims + appliers. §13.6's divergence ledger becomes the diff
  between two spec instances.
- **The relay seam gets finished**: the 20 inline chrome sites in `main.tsx` route through the
  same facade the other 12 sites already use. `relay.ts` grows the `CdpBus`/`FakeBus`
  implementations (three functions each).
- **`sw.ts` stays exactly as it is** — 141 lines of genuinely-privileged broker is the *right*
  size for the part that must be an extension.
- One deliberate non-goal: `content.ts` remains a content script (its bodies are already shared
  modules); the harness delivers the same modules via `Runtime.evaluate` instead.

## 6 · Answer to the owner's question

**Yes at the lane level, no at the conductor level, and the miss is documented rather than
mysterious.** The pieces (media, capture push, ink, ring, paint, wire, compile) were architected
well — injected-effect seams exist and two subsystems used them perfectly. The conductor was
supposed to be mounted from the overlay and was instead re-grown; that one decision produced
the duplicated 1.5 k-line orchestrators, the five sync obligations, the inverted test coverage,
and most of the bug ledger. The fix is not "componentize the extension" — it is **extract the
one component that was never built: the shared conductor** (the mode engine), and finish the
transport seam that is already 80 % routed.
