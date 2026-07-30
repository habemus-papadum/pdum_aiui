# Decided behavior — the intent client

The interaction contract, as decided with the owner (2026-07-13 review rounds on the detached
page). Where this deviates from the old extension/overlay, the deviation is deliberate and
noted. This file records *how it behaves* — the living interaction contract (the parity
ledger that tracked feature coverage during the port is retired to
`archive/intent-client/PARITY.md`). Every rule here
is pinned by a test (spec.test.ts, client.test.ts, panel.test.tsx).

## The machine

- **Phase ladder**: `disarmed ⊂ armed ⊂ turn` (C3′, owner 2026-07-25 — tweak DIED: armed
  means the grammar is live — a few claimed keys — a turn claims the whole keyboard, the
  pointer belongs to explicit modes, and DISARM is the escape hatch). State is the product of
  orthogonal regions; commands are the only writers; cross-region invariants are declared
  excludes.
- **Step out (Esc / the ✖ cap) unwinds the whole ladder, one level per press**: help closes
  first (the esc order), then turn → turn-cancel → armed → **disarmed**.
  *Deviation from the old client* (whose Esc never disarmed): stepping out of armed IS
  disarming — the ladder has no floor.
  Where the Esc KEY works: in-turn everywhere (the grammar claims it); outside a turn, only
  in the **panel's own document** (a panel-local listener) — on the target page, keys belong
  to the page outside a turn, so Esc there rightly passes through. The ✖ cap always works.
- **There is ONE disarmed, and it is hard**: however you reach it (Esc's last step, the arm
  cap, the `d` key), pencil mode clears. Declared once as the `disarmed-is-hard` exclude — not
  remembered per route. Standing video/videoMode survive disarm (as in the old client).
- **The arm cap is a status indicator you can press**: lit = armed-or-deeper; press arms from
  disarmed (gated on the channel) and hard-disarms from anywhere else — a one-click abandon,
  no confirmation (owner-accepted).
- **Send keeps you armed** (old divergence 2, kept). **The turn cap is a lit TOGGLE while a
  turn is open** (owner, 2026-07-14, superseding lit-but-disabled): pressing it again abandons
  the turn back to armed — the escape-from-turn rung as one click. Leaving via the cap cancels
  the thread exactly like Esc.
- **A content-ful abandon via the cap asks first** (owner, 2026-07-20, narrowing the line
  above). When the cap would abandon a turn that *holds content* (the same `turnHasContent`
  predicate `send` uses to tell a real turn from an empty one), it raises a confirm dialog
  instead of abandoning outright — a stray cap tap meant for Enter should not silently discard
  what you built. The dialog teaches the two deliberate exits (**Enter** sends · **Esc**
  exits); **Esc and Enter both dismiss it and keep the turn** — only a click on its danger
  button abandons. An **empty** turn keeps the instant one-click abandon (nothing to lose), and
  the gate is the **cap's alone**: the Esc key, `d`, and the arm cap still abandon immediately,
  and programmatic routes (agent `control()`, the activation gesture, tests) never see it. The
  gate lives entirely in the panel UI — the machine's `turn` toggle is unchanged.
- **The selection cap is enabled only when the page HAS a selection** (owner, 2026-07-14): a
  pull with nothing selected is a guaranteed miss. Disabled, its tooltip points at the remedy —
  select something on the page, come back. The `sel` pill mirrors the same fact.
- **Help is a standing root-level toggle** (blank system: arm · step out · help). Esc
  dismisses it before anything else; it SURVIVES window blur (owner, 2026-07-15) — a
  reference card must be readable while the target page has focus. Its table always shows
  the full in-turn keymap from the one working source (`hintsFor`): live in a turn, and
  outside one the same rows dimmed as a PREVIEW under a single "these keys live in-turn —
  the turn cap opens one" note, so pre-turn help is a real reference card, not a one-line shrug.
- **Unknown in-turn keys swallow + blip** — never exit, never leak to the page. One carve-out
  (C0, 2026-07-25): a key born inside a page's own text field (input, textarea, select,
  contenteditable, role=textbox) belongs to the FIELD — the wholesale claim yields on the page
  side, with the same predicate the panel document already applied
  (`page/typing-target.ts`, one function shared by both tiers and the panel; pinned by the
  surface-parity test).
- **A dimmed cap is a REFUSED command, not a discouraged one.** Availability is a gate the
  machine enforces (`dispatch` consults `spec.available`), so every route in — a cap tap, a key,
  an agent's `control()` write, a recovered turn — meets the same answer. Anything less makes
  the bar a suggestion: found live, where arming was gated on the channel in the bar and *not*
  in the machine, so a keypress could arm a client with nothing to talk to.

## Arming rides the connection; the invocation gesture is grant-only

(Owner, 2026-07-20 — superseding the ⌘./⌘B activation ladder, which is retired along with
the `chrome.commands` chord itself.)

**The armed grammar (C3′).** While ARMED the page carries a claimed-key SET — exactly the
armed layer's live bound keys (Enter opens the turn; h hands-free; j jump; k pencil; c clear
while pencil is on; v/f video; d disarm) — and every other key stays the page's, untouched.
In a TURN the claim widens to the whole keyboard (below). **Escape is never claimed on the
page outside a turn** (pages need Esc for their own modals; the panel's local Esc always
steps the ladder). Typing targets are exempt everywhere (C0).

**Arm-on-connect.** The client arms itself on the channel-connected EDGE (client.ts wraps
`setContext`; one home, every host and tier inherits it). A repeated `connected: true` write
is no edge, so a deliberate disarm sticks while the session holds — but a RECONNECT re-arms
even after a deliberate disarm (decided: the simplicity is worth the rare surprise). An
outage never disarms (it just grays the pill), and the edge only arms from disarmed, so a
connection blip never disturbs an open turn. The arm cap keeps working by hand in both
directions.

**The invocation gesture** (the extension's toolbar click or context-menu grant item; the
plain page's simulate-strip stand-in) is an imperative event from outside the modal system —
never a cap's key hint — and it now does exactly one thing: **record the capture grant**
(`activationGesture()`, src/activation.ts). It moves no phase: arming belongs to the
connection, turns belong to the turn cap, and nothing ever auto-cancels. In the MV3 tier the
gesture IS the grant: `tabCapture` standing is invocation-gated, and Chrome confers it only
for its own surfaces (toolbar action, context menu) — a DOM button's click is a user gesture
but not an extension invocation, which is why no in-page button can mint it.

**The grant banner** (panel-layout.tsx, both entries structurally): while the tab in view
lacks the grant (`grantedTab !== activeTab` — only ever true on a grantful host), a standing
quiet banner names both remedies — right-click → *aiui: grant capture on this tab* first
(it works with the toolbar icon unpinned), then the toolbar click (pin it for one-click
grants) — and states that only pixels need the grant. It disappears the moment the grant
lands and returns on a switch to an ungranted tab. A signpost, not an error: never a toast.

## Sources alongside turns — the tranche-C direction (owner, 2026-07-25)

**Decided direction, landing in slices.** Capture SOURCES — video, the mic, the pencil
surface — belong to the ARMED scope; a TURN is a routing fact (what the prompt collects), not
the power switch. Only the prompt-building routes stay turn-scoped; the iPad mirror needs no
turn at all (the owner's mandate, re-confirmed live: video must not be turn-gated). The old doctrine "armed means the client owns the events" was never what the
shipped machine did — armed gates only the ring and turn-openability — and it is retired as a
goal: while merely armed the page keeps its keyboard and pointer, and interference rides
explicit MODES (pencil on, a turn open), never the phase.

Landed so far (C0): the page-side typing-target carve-out (above), and the key stack split
into the in-turn swallow layer over an **armed-level pass layer** (`armedLayer`, empty today)
— armed-scope keys arrive as table rows in the C1/C2/C3 slices. The sticky/replay capability
table is single-sourced (`STICKY_CAPABILITIES`, transport.ts) so a page assertion added for
one tier cannot silently not-survive reloads on the other.

**C1 (landed): the warm stream is ARMED-scoped.** `tabStream` derives on
armed-with-a-grant and releases only on disarm: the iPad mirror runs with no turn open, a
turn end no longer freezes it, and an in-turn shot rides the same warmth it always did. The
CDP tier's screencast already had a viewer-driven lifecycle (a joining iPad starts it) — C1
made the MV3 tier agree. **Video SAMPLING stays turn-scoped on purpose**: sampled frames
feed the PROMPT, and the prompt is the turn — that is the sources/routes line, not a
leftover.

**C3′ (landed): the armed grammar, standing hands-free, jump-armed — and tweak is DEAD.**
The ladder is `disarmed ⊂ armed ⊂ turn`; the page keylayer claims the armed grammar's live
bound set while armed and the whole keyboard in a turn (the claimed-key set rides the claim's
payload — pinned by the surface-parity test); Enter-while-armed opens the turn; hands-free
and jump are standing modes (see their sections); disarm is the escape hatch.

**C2 (landed): the pencil rides armed.** The mode toggles, the surface engages, and clear
works while merely armed (see "Markup: the pencil"); the pencil cap moved to the armed tier,
so the iPad's remote bar carries it with no turn open; `k`/`c` ride the armed key layer
(panel-document scope — page keys stay the page's outside a turn). Still turn-scoped until
its slice lands: talk/hands-free (C3).

## The sink, and pausing a turn (owner, 2026-07-30)

**Contributions route to a SINK, and the sink is the one predicate.** Everything that ADDS to
a turn — transcribed audio, shots, the area drag, selection pulls, sampled video frames, a
hold-to-talk press — gates on `sink(state)` (spec.ts), not on the phase. Two sinks exist:
`"turn"` (an open, **unpaused** turn) and `"oracle"`, which WINS while it is on. Entering
the oracle therefore pauses the turn *by construction* — the sink is elsewhere — and leaving
restores whatever the turn's own state was, because the oracle never writes the manual
`paused` region. No memory, no restore logic, anywhere. See "The oracle" below and
docs/proposals/intent-oracle.md.

**A suspended turn is one that exists but is not collecting** (`turnSuspended`), whichever
cause suspended it. The lanes gate on THAT, not on the `paused` region: an oracle detour
brackets the stream, suppresses boundaries, and runs the resume compare exactly as the ⏸ cap
does. (Gating on the region alone let a mid-oracle navigation land in the turn behind it —
found by a spec test, not in the wild.)

**Pause (`⏸` / `b`) suspends collection, not the turn.** An orthogonal `paused` toggle — not
a phase rung — meaningful only in a turn (`pause-needs-turn` resets it on exit, so no turn
ever opens pre-paused). While paused:

- **Nothing is collected, and the refusal is the machine's** (`available` reads the sink), so
  caps, keys, the iPad's remote bar, and agent `control()` writes all meet the same answer.
- **The talk WINDOW closes; the talk MODE stands** — the same mode/window split hands-free
  already has across sends. Resume reopens the window by itself. A *hold* ends
  (`hold-needs-a-sink` — you cannot be holding Space into no sink); area mode clears
  (`area-needs-a-sink` — a live crosshair would fire a shot into the paused turn). Mute
  persists across pause exactly as it persists across a send.
- **Standing modes are untouched**: hands-free and video stay lit (they just have nothing to
  feed — sampling stops with the videoPump claim and restarts on resume); the pencil keeps
  working entirely — markup is page state, not turn content (a post-resume shot is what
  carries it into the prompt).
- **Send, cancel, pause, and Esc stay live.** Pausing and then sending what you have is the
  point. The keyboard claim is unchanged (a paused turn is still a turn — the page's keys
  stay claimed, and `b` resumes from anywhere).

**The stream carries a reason-free bracket.** `turn-pause` / `turn-resume` events
(aiui-lowering-pipeline) mark the gap — never composed into the prompt, visible in the trace.
Deliberately NO reason field: a manual pause and a future oracle detour read identically in
the stream; the *banner* is where the reason lives. Do not add one.

**Boundaries across a pause collapse to a comparison (owner, 2026-07-30).** Intermediate
navigations and tab switches while paused are suppressed — where the user wandered is
nobody's business. At resume the client compares the tab in view against a snapshot taken at
pause: a different tab emits ONE `tab-switch`, the same tab on a different URL emits ONE
`navigation` (kind unknown), unchanged emits nothing. The boundary lands after the
`turn-resume` bracket — its position is the attribution, as ever. (The compare is
best-effort async; a word spoken in the first instant after resume can land before it — the
accepted-race family.)

**A reload during a pause resumes collecting.** `paused` is not durable and the exclude
clears it before recovery re-opens the turn; recovery also closes a dangling `turn-pause`
bracket in the recovered stream (the reload was the pause's end). The pause-time tab
snapshot does not survive, so no resume boundary is emitted — the honest limitation.

**The cluster and the hoist.** The turn tier's children are exactly **send · pause ·
cancel** — what you do *with* the turn, bracketed beside the lit 💬 cap. The contribution
caps — shot, area, selection, push-to-talk — are HOISTED to the armed tier (the same move
C1/C2/C3′ made for video, pencil, and hands-free), visible whenever armed and dimmed unless
a sink is live. Their keys ride the armed layer as **sink-gated** rows that `pass` with no
sink — so while merely armed the page keeps `s`, `a`, `p`, and Space (scrolling), exactly as
C3′ promised; the rows go live the day an armed-scope sink (the oracle) exists. Pause is
`remote: true` (the couch case); cancel is desktop-only — its confirm gate lives in the
panel UI, and a remote cap would silently bypass it.

**Cancel is its own command (`cancelTurn`), and a content-ful cancel confirms.** The turn
cap keeps its toggle-to-abandon (muscle memory, documented above); the explicit cancel cap
is the unambiguous spelling. Both routes raise the same confirm dialog when the turn holds
content — one click must not discard a five-minute brief. Esc, `d`, and programmatic routes
stay immediate, as before.

## The oracle — the second sink (O3a, owner 2026-07-30)

The full contract is docs/proposals/intent-oracle.md; what the client guarantees:

- **A region AND a claim.** `oracle` (`🔮`, `o`, armed-scope, durable, `remote: true`) is the
  DESIRE; the `oracleSession` claim is the reconciled reality, so connecting / live / failed
  is the reconciler's status — the `oracle` pill — and never a flag kept in step by hand. A
  refused mint leaves the cap lit: you asked, the world said no, pressing again retries.
- **`disarmed-is-hard` closes it.** A live WebRTC session with an open mic must never
  outlive disarm; that is what the escape hatch is for. Not in `escOrder` (like pencil and
  jump).
- **It listens the moment it is on, and PARK is its whole mic control** (owner,
  2026-07-30). The oracle does not touch the talk region at all: hands-free and
  push-to-talk are the turn's grips and have no meaning here, because the oracle hears
  through its own WebRTC track with its own park. Turning it on means listening; `⏯` park
  gates the track and keeps the session ($0, connection open); turning it off ends it.
  (O3a briefly routed the grips into the oracle. It was a mistake — two independent
  mechanisms answering one question — and un-picking it is what makes "leaving the oracle
  restores the turn exactly" true by construction: nothing about the turn's talk state is
  ever touched, so there is no hot mic on entry and none on exit.)
- **The gate is applied on every edge AND once more when a session finishes connecting** —
  a connect is not an edge, and the vendor's track comes up enabled.
- **A hold ends when the turn stops collecting**, including the oracle taking over
  (`hold-needs-the-turn`) — a gesture with no consumer is nothing. A standing hands-free
  MODE survives: its window closes on the way in and reopens on the way out.
- **One fresh credential per session, and no session outlives the vendor's ~60 minutes.**
  Two clocks: the minted secret's TTL bounds how long it may OPEN a session; the vendor's
  cap bounds how long an open one runs. A session that ends unasked drops the desire and
  says why — the cap never stays lit over a dead session, and 🔮 starts a fresh one.
- **Each sink owns its capture path.** The oracle's WebRTC track is opened once at connect
  and only enabled/disabled after; the turn's talk lane has its own source. A handover stops
  one and flips the other's boolean — no device re-open, and never two captures at once.
- **Audio routes to either sink today; pixels and selections do not yet.** Shot, area, and
  selection stay TURN-only (`contributesToTurn`) until their lane verbs learn to fork —
  refusing at the machine rather than landing in the suspended turn behind the oracle.
- **Gated on a channel and a mic that was not refused.** `micGranted: undefined` means
  nobody has asked yet and must not dead-end the cap; only a definitive `false` refuses.
  Turning a session OFF is always allowed, even after those gates lapse.
- **Three tool groups, three standing toggles** (`app tools` · `panel tools` · `file
  tools`). Each toggle is the coarse on/off; a group turned off is ABSENT from the surface,
  never stale. **File tools are off by default** — reading a project's source is a bigger
  step than driving its UI, and it should be a deliberate one.
  - **panel** — `panel_bar_list` reads the bar (label, key, enabled, engaged) and
    `panel_bar_dispatch` presses a cap. Writeable, and the permission is **declared per
    cap** (`oracle: true` in caps.ts, mirroring `remote`): absent means no, so a cap added
    later is excluded until someone opts it in — the property a deny-list cannot offer.
    Three families deliberately carry no flag: the turn LIFECYCLE (send is irreversible and
    outward-facing), the LADDER (each would end the session that is asking), and its own
    HEARING (the mic is the user's, and a model that can gate its own input can lock itself
    out of the instruction that would restore it). Two gates apply: the flag says *never*,
    `canDispatch` says *not right now*, and the two refusals read differently on purpose.
  - **files** — `read_file`, `list_files`, `grep`, executed channel-side over
    `POST /intent/oracle/tool` (the oracle speaks WebRTC from the browser, so a filesystem
    needs a crossing). The executors and their policy are the prompt linter's own: one
    implementation, two advertised subsets — the linter still offers `read_file` alone,
    because its brief is "verify a suspicion", not "browse". Every bound is SURFACED, never
    silently applied: a model told it was truncated can narrow its search; one handed a
    complete-looking list cannot. Every call and result lands in the oracle's ledger, which
    is what keeps these reads as visible as the linter's are in the trace.
- **It holds the tools of the page in view** (O3b, the `app tools` toggle): the
  tab's `window.__AIUI__.tools` registrations, projected onto the live session and
  **re-projected mid-session** whenever they change — a tab switch, a navigation, or an app
  registering a tool at runtime. Namespaces prefix only when more than one registers (two
  namespaces' identically-named tools would collide in the vendor's flat space). A tool is
  bound to the tab it was projected FOR, so one can never fire into a page it was not built
  for; the toggle off means an EMPTY surface, never a stale one. The panel keeps its own
  local view of these descriptors (`page-tools.ts`) rather than reading them back through
  the channel's tool directory — same event stream, two independent consumers, and the
  `callId` spaces are kept apart so neither settles the other's calls.

## The bar

- **A tree presented linearly**: root `arm · step out · help`; arming reveals the turn cap,
  its cluster (send · pause · cancel while a turn is open), and the standing tier — the
  hoisted contribution caps (shot · area · selection · push-to-talk, dim without a sink)
  plus jump, hands-free, video, pencil; an engaged cap reveals its children (pencil →
  clear · vanish · fade; hands-free → mute; video → cadence · rate). The renderer joins the
  depth tiers into one wrapping flow with a `›` divider — no indentation, no one-cap rows.
- **Labels are stable**: a cap's text never changes with state; the lit highlight carries
  "engaged". Keyboard shortcuts are never cap text — tooltips and the help table only.
- **Enabled is derived**: the engine dry-runs the reducer (`canDispatch`); verbs and gates
  declare `available` in the spec. Nothing is hand-written per button.
- Verb caps (shot · selection · clear) flash briefly on tap — they move no region, so the
  acknowledgment is the reaction.

## Markup: the pencil (owner, 2026-07-16; sole markup tool since the ink removal)

The pencil replaced the legacy ink surface (it was integrated as ink's exact twin, and the
twin won). The shape, at every layer: a durable on/off mode region (`pencil`, `k`, cleared by
`disarmed-is-hard`), a reconciler claim that engages the in-page surface while the mode is on
**armed or in a turn** (C2, owner 2026-07-25 — markup is a source; the founding complaint was
opening a turn just to clear ink)
and re-points it on a tab switch (`pencilSurface`), a clear gated on the mode — armed or
in-turn — (`c` / the bar; the cap lives on the ARMED tier now, desktop and iPad remote bar
alike), and vanish/fade as config controls with a live re-relay effect. The surface owns the
pointer only while the mode is on, and **strokes survive leaving the mode / the turn** — only
a clear or a fade removes them. On the
host the pencil takes **mouse, pen, and touch** (native `localInput`); palm rejection is the
remote iPad client's job (its `shouldCapture` veto), never the desktop's. The iPad rides the
same surface through the `remote*` ops.

## The page-pointer tools are one mode at a time (owner, 2026-07-16)

**`pencil` · `area` · `jump` each own the page pointer with a full-viewport overlay, so
exactly one is on.** Turning any on turns the other two off (the command clears them — an
exclude can't express "the last one pressed wins"). This is what made `area` (`a`) and `jump`
(`j`) real **toggles** instead of one-shot command-flashes: pressing the key enters a lit mode
that stays until you act, toggle it off, hit Esc, or leave the turn — the cap lights (`active`)
while engaged, exactly like pencil.

- **`area`** raises the crosshair rubber-band on the granted tab (a `regionSurface` claim, pixels
  → follows the grant). It **auto-exits after one drag**: the page reports `regionDrag`, the
  lanes crop + upload the shot, and the mode flips off (`regionDone`).
- **`jump`** raises the editor picker on an instrumented tab (a `jumpSurface` claim, a page act →
  follows the tab in view). It **auto-exits on a commit or cancel**: the page reports `jumpDone`
  (jump-mode's `onExit`) and the mode flips off.
- **Transient vs standing**: `area` needs an open turn (its shot lands in the prompt), so
  leaving the turn clears it (`area-needs-turn`). `pencil` and `jump` are STANDING,
  armed-scope (C2/C3′ — markup and jump-to-editor are not prompt acts); only disarm clears
  them.
- **Escape is one source of truth.** With a tool on, Esc cancels *that tool* and keeps the turn
  (`escOrder: help → area → jump → phase`), then the next Esc steps the phase ladder. The page
  overlays no longer run their own private Escape listeners — the old split-brain (page-Esc
  cancelled the drag while panel-Esc stepped the phase, neither knowing about the other) is gone.
- **Never stranded**: once a tool is on you can always toggle it off, even if its precondition
  lapses (the tab de-instruments, the grant moves) — `available` gates the turn-*on*, not the
  turn-*off*, and Esc bypasses `available` entirely.

## Talk — the audio source

Talk is the capture bus's **audio source** (capture-bus-and-consumers.md §1): what is being
*sensed*, independent of who consumes it. The consumers — transcriber and linter — are
routes onto it ("Sources, routes, and turns" below). Two source-level invariants:

- **Mute is a property of the source, never of a route.** "Muted" means *nothing in the system
  is listening* — there is deliberately no "audio to the linter but not the transcriber" and no
  per-consumer mute. A route is subscribed or not; the source is live or muted.
- **One exclusive talk region, whoever consumes it.** The talk machinery below is identical in
  every journey; only the route set changes.

**One exclusive talk region (`off | hold | handsFree`), two engagement affordances.** A second
simultaneous talk window is unrepresentable by construction. Push-to-talk is a *gesture*:
hold Space, or press-and-hold the 🎙 cap (pointer down/up = the same `talkPress`/`talkRelease`
commands). Hands-free is a *mode*: the `h` key or the 🎧 toggle cap. While one grip is engaged
the other's cap disables (`h` switches grips; Space during hands-free does nothing; Space-up
only ends a hold). Hands-free is a standing mode (above); a hold ends with its turn.
Mute exists only while a window is open; starting talk starts unmuted. The REC pill is the always-visible
recording indicator: red while live, amber while muted.

**Hands-free is a STANDING mode (C3′, owner 2026-07-25) — the mode survives turns; the
WINDOW rides the consumer.** Toggling `h` while merely armed lights the mode with nothing
recording (there is no consumer — deliberately: "dropped on the floor" is implemented as
no-capture). A SINK appearing routes it — the window (real capture + upload) opens to the
transcriber/linter when an unpaused turn opens — and a send (or a pause) closes the window
while the MODE stands, so the next turn (or the resume) reopens it by itself. Only disarm
ends the mode (`disarmed-is-hard`). A *hold* (Space) stays sink-scoped: it is a gesture, and
a gesture with no consumer is nothing (`hold-needs-a-sink`).

## Sources, routes, and turns (the capture bus)

The audio source above fans out to **routes** — who is listening (capture-bus-and-consumers.md,
Phase 2 implemented 2026-07-18):

- **transcriber** — audio → transcript → builds the prompt. The default; always on in the BRIEF
  journey.
- **linter** (converse, on-demand) — accumulates silently and speaks one comprehensive
  advisory read when the **lint now** button asks; never touches the prompt. (Overhear — the
  automatic pause-lints — retired 2026-07-19.)
A third route, the **oracle** — a direct voice conversation the mic was ADDRESSED to — was
**deleted end to end** as a route (owner, 2026-07-25/26): no `oracle-*` events in the
pipeline vocabulary, and the journeys' XOR (oracle ⊕ linter) died with it. It came back
2026-07-30 as something else entirely — not a route onto the turn but a **second SINK**
(`packages/aiui-oracle` in the panel, O3a above): it still contributes NOTHING to turns or
prompt lowering, and the pause bracket an oracle detour leaves in the stream is deliberately
reason-free. `docs/guide/oracle.md` keeps the persona of record.

**Reply audio STREAMS (owner, 2026-07-19: "we don't want whole playback anything").** Every
live consumer's spoken reply reaches the client as `seq`-ordered PCM chunks the moment the
vendor generates them, scheduled gaplessly — the first audible byte does not wait for the reply
to finish. Barge-in is client-boundary-driven: the LINTER runs manual VAD (its vendor cannot
detect the human talking over it), so the cancel rides talk-start and the `stop` button. TTS
acks — whole little files — keep the clip path.

**Shots and selections are journey-independent:** they land in the prompt AND forward to
whichever live consumer is on.

### The prompt linter, reconfigurable mid-turn

The linter select (`off | openai | gemini`) rides the hello on every thread-open, but it also
takes effect **live** (owner, 2026-07-16): flipping it while a turn is open sends a `control`
chunk on the open thread, and the channel processor starts / stops / swaps the linter sidecar
without closing the turn. With no open thread the change simply rides the next hello. So all
three — start, stop, and vendor swap — work mid-turn; a swap gets a *fresh* sidecar (it lints
from that point on, it does not inherit the prior session's audio/selections). The model,
instructions, and voice stay the hello's — the select carries only the vendor.

**The linter is on-demand — converse is its only turn strategy (owner, 2026-07-19; overhear
retired).** There is no automatic pause-lint: while the linter is on it ACCUMULATES — your
voice, shots, selections, and each segment's transcript (injected as silent context as it
lands) ride one open vendor window across talk segments. The **"lint now"** button
beside the select (`{ control: "lint", value: "now" }` on the mid-thread rail) is the whole
turn interface:

- **lint now** ends the vendor turn over everything accumulated — one comprehensive lint. It
  never waits for a pending STT final (the accepted race: a final landing moments later informs
  the *next* lint). When the reply completes, the channel pushes `linter-turn-complete` and the
  pulse settles to idle. **Stay-on**: the linter remains on — talk again and the window
  reopens; press again and it lints again. The select is the only off switch. Enabled while
  the pulse shows `listening`; a press with nothing accumulated is a no-op end to end.
- Voice barge-in (talking over a reply) cancels it — a human talking wants to keep
  briefing, not listen. (The "stop" button that duplicated this was removed 2026-07-19:
  barge-in covers the abort, and the select's `off` is the off switch. The channel still
  honors `lint`/`stop` on the rail.)

## Continuity: navigations and tab switches

A same-tab navigation and a tab SWITCH are **two distinct boundary events**, both riding the open
turn as context (never a turn opener — no thread, no event) and both rendered into the lowered
prompt. They are separate on purpose (owner, 2026-07-16): a same-tab move is a `navigation`
event (with a `navKind`: push/replace/traverse/reload/hash), a tab change is a `tab-switch` event
carrying **both tab identities** (`fromTab`/`toTab`) plus both hrefs — so the compiler can phrase
"you switched tabs" distinctly from "the page navigated". A tab boundary re-reads `from` at
boundary time (the tab may have navigated since it was last active).

**What survives a mid-turn reload (decided in Phase 3, on real pages):** the turn does. A reload
gives the page a new document, which carries none of what the client asserted into the old one —
and the client's *desire* has not changed, so no claim re-applies on its own. The host therefore
re-arms the new document: the ring and the key layer come back, pencil MODE comes back (a
fresh surface), and the **strokes do not** — they were drawn on the document that is gone. The turn's
events, including the navigation itself, are untouched.

**Capture across a tab switch differs by host — decided facts:** the extension's `tabCapture`
is per-tab and invocation-gated, so the warm stream re-points on switch; standalone
`getDisplayMedia` is pinned to the surface the user picked and CANNOT follow a switch; the
CdpBus tier needs no grant at all for stills (`Page.captureScreenshot`), so shots and sampled
frames follow the active tab freely — only true continuous video inherits the pinning.

**Whether a capture GRANT exists is the host's business, not the user's.** A host declares
whether the grant is free (`CaptureSource.grantless`). MV3's `tabCapture` is invocation-gated, so
its grant is a real fact the invocation gesture mints, and the pixel acts stay dark until it
does. The CDP tier's screenshots ask nobody, so there is nothing to mint: the grant simply *is*
the tab in view. Consequence, and the bug it fixes (found live): arming without a grant (the
connect edge, the arm cap) must open turns exactly like an invoked client — a grantless armed
seat mints nothing, so gating turns on the grant would dead-end the bar; only the capture acts
gate on it, individually.

**The gate split (owner, 2026-07-14): the page transport follows the tab in view; pixels follow
the grant.** Only the pixel acts — shot, the warm stream, video sampling — gate on the grant.
Selection, the pencil, its clear, and keys are PAGE acts: they ride the content script / bootstrap, which is
on every tab, so they follow `activeTab` and never ask for a grant. Under MV3 a tab switch
therefore darkens *capture only*; everything else keeps working on the new tab. And the pixel
acts require the granted tab to BE the tab in view: after a switch the grant persists on the old
tab, but shooting (or sampling) a tab you are not looking at would lie about what the turn saw —
the acts go dark until the gesture re-grants, while the warm stream stays held on the granted tab
so returning to it costs nothing.

**The ring has FOUR states, and the fourth is how the page says "grant here" (owner,
2026-07-14 — no toast; the ring carries it).** Off · steady (armed) · breathing (turn) · **hollow**: armed,
but THIS tab's pixels need a grant. Hollow renders outline-only in the phase's tone, with the
grant hint beside it. The hint text is supplied by the host (the MV3 bus names the invocation
surfaces, context menu first — the chord and its `chrome.commands.getAll()` lookup are gone,
2026-07-20) and handed down as a string; **nothing below the host hard-codes it.** The client's
ring desire names the granted tab; each bus projects it per tab (`ringForTab`, one shared pure
function): solid where the grant is, hollow everywhere else. Grantless hosts never produce a
grant fact, so the hollow state simply cannot occur there. The panel-side twin of the hollow
ring is the grant banner (above), which spells out the long-form remedies.

## Which tab the client is aimed at (the leader)

The client drives **the tab you are looking at** — the old client's `lastActiveTab`. On real
pages that means VISIBILITY, not keyboard focus: `document.hasFocus()` is false for every page
whenever the browser itself is not the frontmost app (you are typing in your editor, or an agent
is driving), so a focus-only rule aims the turn at whatever it happened to see first. Visibility
leads; focus only refines it when the browser has focus and several windows each show a tab.

Two consequences, both deliberate: **looking at the panel never blanks the leader** (the panel is
not a page the client drives — it is excluded from targeting entirely, along with devtools and
browser pages), and **closing the leader hands the role on** rather than leaving the client aimed
at nothing.

The exclusion covers the panel's **entire own origin**, not just recognizable `/intent/` URLs:
the dev-served panel lives at a root path (`localhost:<vite>/?channel=…`) that no URL pattern
can identify, so the bus excludes everything on `location.origin` — the origin it itself is
served from. Before this rule the panel instrumented ITSELF (rang, marked up, keylayered its
own document, with no way to clear the strokes short of ending the turn — found live
2026-07-15).
Self-driving is an explicit non-goal: the panel is furniture, never a markup target.

Under the extension the browser answers this question directly (`chrome.tabs.query({active:
true})`) — no visibility heuristic is needed or wanted — and a **side panel drives only its own
window's tabs**. It is per-window by construction, so a panel never aims at a tab you cannot see
from it, and another window's page reports (which every panel hears) are dropped.

## Two clients, never both armed

The greenfield client and the frozen extension are separate extensions — separate ids, separate
storage (`aiui2.*`) — so both can be installed, and only one may hold a tab. They cannot speak to
each other (runtime messages never cross extension ids), but they share a DOM: the frozen client's
ring wears an `armed` class while it holds the page. The content script watches for it, reports it
as a `foreign` world fact, and the `arm` gate refuses on a tab it holds. The bar dims, and — since
availability is a gate, not a hint (above) — the key and the agent write are refused too.

The reverse (this client armed, the frozen one refusing) is not enforced; the frozen client is
frozen. In practice one drives, the other is the safety net.

## The segment editor (selective fixing of a turn)

**One segment at a time** (a hands-free session / one push-to-talk hold), in a POPUP — never
inline in the preview. The popup shows the segment's text with its interleaved items as **atomic
emoji** (non-editable spans carrying their marker): they move whole or die. **Moves are
ignored** — positions belong to the compiler's timestamp interleave; **deleting one is a delete
command** (the same drop verbs as the preview's ✕). Apply re-timestamps the new text against the
old words (kept words keep their MEASURED times — that is what keeps shots anchored through an
edit; inserts interpolate; a total rewrite spreads over the original span) and speaks
`segment-replace`; the pipeline reflows the images. The original transcript stays in the stream
for the trace.

**Paste** works in the same surface: text pastes plain (or as Markdown when the clipboard's HTML
gains anything); an image paste drops an atom at the cursor and, on Apply, becomes a shot with
`origin: "paste"` — lowered as `<pasted-image …/>`, never "screenshot" — anchored by a synthetic
`takenAt` from the words around it, so the compiler's own interleave places it. "＋ add" at the
preview's tail is the same editor in append mode: text becomes a contribution; images anchor at
the end. A typed contribution has no talk window, so its mid-segment pastes keep arrival order
(honest limitation). The popup claims Esc ahead of the ladder while open; ⌘⏎ applies.

## Instrumented pages (aiui support)

Pages announce `window.__AIUI__` instrumentation as a world fact (`ctx.aiuiPage`, the `aiui`
pill). Instrumented pages answer the `locate` capability (screenshot rectangle → components →
source), and they light the **jump** act (landed 2026-07-15; it was never in the old
extension): `j` in a turn toggles jump mode on (see "The page-pointer tools are one mode at a
time") — move highlights the nearest stamped element, click opens the in-page picker (stamped
element ancestors + containing cells at their definition sites, the overlay's interaction
contract), commit opens `vscode://file/…`. A commit or cancel auto-exits the mode. Fully
page-side (src/page/jump-mode.ts; the CDP tier evaluates it with the page bundle, MV3 runs it in
the MAIN world — the source root and cell registry live there). The gate IS the feature
detection: no `__AIUI__`, gray cap (and once on, always toggleable off).

## The CDP-alignment signal (owner, 2026-07-19)

**One first-class fact — `ctx.cdpAlignment` — answers: does the browser this client runs in
match the browser the bound channel drives over CDP?** The agent behind the channel may hold a
Chrome DevTools MCP pointed at the channel's session browser while the client runs in a
completely different Chrome; nothing else makes that visible. Evidence comes from both sides:
the local **driver ROSTER** (`aiui2.cdpDriver:<port>` entries, one per channel, each written
into the extension through the browser's own debug endpoint — self-verifying; cdp/tagger.ts.
The single-slot tag this replaced flapped last-writer-wins under two channels) and the
channel's own report (`/intent/cdp/info`, which carries whether its tagger landed). Five
states (src/cdp-align.ts, pure + tested): `aligned` (bound ∈ roster; `coDrivers` = the others)
· `driven-by-other` (a nonempty roster without the bound channel; entries are staleness- and
liveness-filtered first) · `channel-drives-other` (the agent's browser is elsewhere) ·
`channel-no-cdp` (the agent has no browser — normal, calm) · `unknown`. Honesty bound: a
browser cannot name its own debug port from inside, so "this browser has a port but nobody
tags it" is invisible by construction.

**Multi-agent co-driving of one browser is a SUPPORTED workflow.** Several channels may tag
the same browser (each owns its roster slot); `coDrivers` is how sharing surfaces — never a
conflict to prevent. **Debug-ness is deliberately not part of this signal**: a debug channel
is treated as just another parallel agent; "(debug)" surfaces to the user in the channel
dropdown alone.

Three consumers, one writer (the extension's supervisor, ext/align.ts, which also decorates
drivers with registry labels; the page tier fixes the verdict at boot — the CDP bridge
attaching IS alignment by construction):

- **the `cdp` pill** — green aligned (solo) · **PURPLE aligned-and-shared** (other channels
  co-drive this browser) · red driven-by-other (also toasts) · amber channel-drives-other ·
  gray no-cdp/unknown;
- **the hello's `meta.cdp`** — the prompt prelude renders an agent-addressed sentence from it
  (channel prompt-context.ts): affirm alignment so the agent uses its DevTools MCP without
  fear — plus, when shared, the parallel-agents heads-up ("tabs you did not open may change
  underneath you") — or warn that DevTools reads will NOT match what the user sees; unknown
  stays SILENT (no false comfort). It rides the traced hello (the `clientContext` stage) for
  free;
- **feature gates to come** read the same fact.

## Status pills (permanent expert strip)

`channel · cdp · mic · rec · stream · video · ink · keys · ring · sel · aiui · ipad` — claim statuses (stream/video/
ink/keys: idle → pending → active → error) and world facts (channel connection, mic
permission, iPad paint clients), stable labels, color = state. Internal detail deliberately
kept visible.
