# Decided behavior — the intent client

The interaction contract, as decided with the owner (2026-07-13 review rounds on the detached
page). Where this deviates from the old extension/overlay, the deviation is deliberate and
noted. PARITY.md tracks feature coverage; this file records *how it behaves*. Every rule here
is pinned by a test (spec.test.ts, client.test.ts, panel.test.tsx).

## The machine

- **Phase ladder**: `disarmed ⊂ armed ⊂ turn ⊂ tweak`. State is the product of orthogonal
  regions; commands are the only writers; cross-region invariants are declared excludes.
- **Step out (Esc / the ✖ cap) unwinds the whole ladder, one level per press**: help closes
  first (the esc order), then tweak → turn → turn-cancel → armed → **disarmed**.
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
- **The selection cap is enabled only when the page HAS a selection** (owner, 2026-07-14): a
  pull with nothing selected is a guaranteed miss. Disabled, its tooltip points at the remedy —
  tweak mode (`t`), select something, come back. The `sel` pill mirrors the same fact.
- **Tweak is a toggle**: `t` or the cap enters; the cap (or the activation gesture) releases.
  In tweak the page owns every ordinary key — pressing `t` on the page must reach the page.
- **Help is a standing root-level toggle** (blank system: arm · step out · help). Esc
  dismisses it before anything else; it SURVIVES window blur (owner, 2026-07-15) — a
  reference card must be readable while the target page has focus. Its table always shows
  the full in-turn keymap from the one working source (`hintsFor`): live in a turn, and
  outside one the same rows dimmed as a PREVIEW under a single "these keys live in-turn —
  activate opens one" note, so pre-turn help is a real reference card, not a one-line shrug.
- **Unknown in-turn keys swallow + blip** — never exit, never leak to the page.
- **A dimmed cap is a REFUSED command, not a discouraged one.** Availability is a gate the
  machine enforces (`dispatch` consults `spec.available`), so every route in — a cap tap, a key,
  an agent's `control()` write, a recovered turn — meets the same answer. Anything less makes
  the bar a suggestion: found live, where arming was gated on the channel in the bar and *not*
  in the machine, so a keypress could arm a client with nothing to talk to.

## Activation is not a key

The browser-global activation shortcut (⌘B under `chrome.commands` in the extension; a plain
listener on the detached page) is **not part of the modal keyboard system** and never appears
as a cap's key hint. It is an imperative event from outside, handled by `activationGesture()`
(src/activation.ts): mint the grant, then sequential idempotent dispatches — arm if disarmed
(respecting the channel gate), open a turn if armed, resume if tweaking, and **never cancel**
an open turn. That function is the repo's reference example of a correct imperative → Solid
boundary: it re-reads committed state between dispatches, which the engine makes safe.

## The bar

- **A tree presented linearly**: root `arm · step out · help`; arming reveals the turn tier;
  an engaged cap reveals its children (pencil → clear · vanish · fade; hands-free → mute;
  video → cadence · rate). The renderer joins the depth tiers into one
  wrapping flow with a `›` divider — no indentation, no one-cap rows.
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
in an open turn and re-points it on a tab switch (`pencilSurface`), a clear gated on the mode
(`c` / the bar), and vanish/fade as config controls with a live re-relay effect. The surface
owns the pointer only while the mode is on, and **strokes survive leaving the mode / the
turn** — only a clear or a fade removes them. On the
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
- **Transient**: `area`/`jump` need an open turn (area needs pixels, jump needs a live picker;
  tweak hands the page to the user), so leaving the turn clears them (`tools-need-turn`).
  `pencil` is durable and survives into tweak; only disarm clears it.
- **Escape is one source of truth.** With a tool on, Esc cancels *that tool* and keeps the turn
  (`escOrder: help → area → jump → phase`), then the next Esc steps the phase ladder. The page
  overlays no longer run their own private Escape listeners — the old split-brain (page-Esc
  cancelled the drag while panel-Esc stepped the phase, neither knowing about the other) is gone.
- **Never stranded**: once a tool is on you can always toggle it off, even if its precondition
  lapses (the tab de-instruments, the grant moves) — `available` gates the turn-*on*, not the
  turn-*off*, and Esc bypasses `available` entirely.

## Talk

**One exclusive talk region (`off | hold | handsFree`), two engagement affordances.** A second
simultaneous talk window is unrepresentable by construction. Push-to-talk is a *gesture*:
hold Space, or press-and-hold the 🎙 cap (pointer down/up = the same `talkPress`/`talkRelease`
commands). Hands-free is a *mode*: the `h` key or the 🎧 toggle cap. While one grip is engaged
the other's cap disables (`h` switches grips; Space during hands-free does nothing; Space-up
only ends a hold). Talk is per-turn — leaving the turn SCOPE ends it, whoever caused the exit.
Mute exists only while talking; starting talk starts unmuted. The REC pill is the always-visible
recording indicator: red while live, amber while muted.

**Tweak pauses talk, it does not end it (owner, 2026-07-16).** Tweak hands every ordinary key to
the page, so a *hold* window — bound to a physical key you can no longer be holding — ends on
entry. A *hands-free* window instead **pauses**: the mic goes quiet (the effective mute is
`micMuted || phase === "tweak"`, driven off the phase in `client.ts`) but the talk window stays
open, so its server-side linter window is not triggered, and stepping back to the turn resumes
the mic where it left off. Leaving the turn scope entirely (armed/disarmed) still ends it.

## The prompt linter, reconfigurable mid-turn

The linter select (`off | openai | gemini`) rides the hello on every thread-open, but it also
takes effect **live** (owner, 2026-07-16): flipping it while a turn is open sends a `control`
chunk on the open thread, and the channel processor starts / stops / swaps the linter sidecar
without closing the turn. With no open thread the change simply rides the next hello. So all
three — start, stop, and vendor swap — work mid-turn; a swap gets a *fresh* sidecar (it lints
from that point on, it does not inherit the prior session's audio/selections). The model,
instructions, and voice stay the hello's — the select carries only the vendor.

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
its grant is a real fact the activation gesture mints, and the pixel acts stay dark until it
does. The CDP tier's screenshots ask nobody, so there is nothing to mint: the grant simply *is*
the tab in view. Consequence, and the bug it fixes (found live): arming from the BAR (`arm` →
`turn`) must work exactly like ⌘B. It did not — the bar mints nothing, so the capture acts stayed
disabled forever while the page acts, which follow the tab in view, worked fine.

**The gate split (owner, 2026-07-14): the page transport follows the tab in view; pixels follow
the grant.** Only the pixel acts — shot, the warm stream, video sampling — gate on the grant.
Selection, the pencil, its clear, and keys are PAGE acts: they ride the content script / bootstrap, which is
on every tab, so they follow `activeTab` and never ask for a grant. Under MV3 a tab switch
therefore darkens *capture only*; everything else keeps working on the new tab. And the pixel
acts require the granted tab to BE the tab in view: after a switch the grant persists on the old
tab, but shooting (or sampling) a tab you are not looking at would lie about what the turn saw —
the acts go dark until the gesture re-grants, while the warm stream stays held on the granted tab
so returning to it costs nothing.

**The ring has FOUR states, and the fourth is how the page says "⌘B here" (owner, 2026-07-14 —
no toast; the ring carries it).** Off · steady (armed) · breathing (turn) · **hollow**: armed,
but THIS tab's pixels need a grant. Hollow renders outline-only in the phase's tone, with the
activation hint beside it. The hint text is discovered by the host — the MV3 bus reads the
command's LIVE binding from `chrome.commands.getAll()` (users rebind it; Chrome silently drops a
conflicted suggestion, and the frozen client claims the same chord) — and handed down as a
string; **no key name is hard-coded anywhere below the host.** The client's ring desire names
the granted tab; each bus projects it per tab (`ringForTab`, one shared pure function): solid
where the grant is, hollow everywhere else. Grantless hosts never produce a grant fact, so the
hollow state simply cannot occur there.

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

## Status pills (permanent expert strip)

`channel · mic · rec · stream · video · ink · keys · ring · page · ipad` — claim statuses (stream/video/
ink/keys: idle → pending → active → error) and world facts (channel connection, mic
permission, iPad paint clients), stable labels, color = state. Internal detail deliberately
kept visible.
