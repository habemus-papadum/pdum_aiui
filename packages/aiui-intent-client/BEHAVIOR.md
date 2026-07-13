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
  cap, the `d` key), ink mode clears. Declared once as the `disarmed-is-hard` exclude — not
  remembered per route. Standing video/videoMode survive disarm (as in the old client).
- **The arm cap is a status indicator you can press**: lit = armed-or-deeper; press arms from
  disarmed (gated on the channel) and hard-disarms from anywhere else — a one-click abandon,
  no confirmation (owner-accepted).
- **Send keeps you armed** (old divergence 2, kept). **The turn cap is lit-but-disabled while
  a turn is open** — it reads as status; send/step-out are the exits.
- **Tweak is a toggle**: `t` or the cap enters; the cap (or the activation gesture) releases.
  In tweak the page owns every ordinary key — pressing `t` on the page must reach the page.
- **Help is a standing root-level toggle** (blank system: arm · step out · help). Esc
  dismisses it before anything else; window blur closes it.
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
  an engaged cap reveals its children (ink → clear · vanish · fade; hands-free → mute; video →
  cadence · rate). The renderer joins the depth tiers into one wrapping flow with a `›`
  divider — no indentation, no one-cap rows.
- **Labels are stable**: a cap's text never changes with state; the lit highlight carries
  "engaged". Keyboard shortcuts are never cap text — tooltips and the help table only.
- **Enabled is derived**: the engine dry-runs the reducer (`canDispatch`); verbs and gates
  declare `available` in the spec. Nothing is hand-written per button.
- Verb caps (shot · selection · clear) flash briefly on tap — they move no region, so the
  acknowledgment is the reaction.

## Talk

**One exclusive talk region (`off | hold | handsFree`), two engagement affordances.** A second
simultaneous talk window is unrepresentable by construction. Push-to-talk is a *gesture*:
hold Space, or press-and-hold the 🎙 cap (pointer down/up = the same `talkPress`/`talkRelease`
commands). Hands-free is a *mode*: the `h` key or the 🎧 toggle cap. While one grip is engaged
the other's cap disables (`h` switches grips; Space during hands-free does nothing; Space-up
only ends a hold). Talk is per-turn — leaving the turn ends it, whoever caused the exit. Mute
exists only while talking; starting talk starts unmuted. The REC pill is the always-visible
recording indicator: red while live, amber while muted.

## Continuity: navigations and tab switches

A same-tab navigation and a tab SWITCH are both **navigation events riding the open turn** —
context, never a turn opener (no thread, no event) — and both render into the lowered prompt.
A tab boundary names both sides, with `from` re-read at boundary time (the tab may have
navigated since it was last active).

**What survives a mid-turn reload (decided in Phase 3, on real pages):** the turn does. A reload
gives the page a new document, which carries none of what the client asserted into the old one —
and the client's *desire* has not changed, so no claim re-applies on its own. The host therefore
re-arms the new document: the ring and the key layer come back, ink MODE comes back (a fresh
surface), and the **strokes do not** — they were drawn on the document that is gone. The turn's
events, including the navigation itself, are untouched.

**Capture across a tab switch differs by host — decided facts:** the extension's `tabCapture`
is per-tab and invocation-gated, so the warm stream re-points on switch; standalone
`getDisplayMedia` is pinned to the surface the user picked and CANNOT follow a switch; the
CdpBus tier needs no grant at all for stills (`Page.captureScreenshot`), so shots and sampled
frames follow the active tab freely — only true continuous video inherits the pinning.

**Whether a capture GRANT exists is the host's business, not the user's.** The machine gates
shot/selection/clear on holding a grant for a tab, and that gate stays — but a host declares
whether the grant is free (`CaptureSource.grantless`). MV3's `tabCapture` is invocation-gated, so
its grant is a real fact the activation gesture mints, and the capture acts stay dark until it
does. The CDP tier's screenshots ask nobody, so there is nothing to mint: the grant simply *is*
the tab in view. Consequence, and the bug it fixes (found live): arming from the BAR (`arm` →
`turn`) must work exactly like ⌘B. It did not — the bar mints nothing, so the capture acts stayed
disabled forever while ink, which follows the tab in view, worked fine.

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

## Instrumented pages (aiui support)

Pages announce `window.__AIUI__` instrumentation as a world fact (`ctx.aiuiPage`, the `page`
pill). Instrumented pages answer the `locate` capability (screenshot rectangle → components →
source) — the seam the overlay's jump-to-VS-Code mode will ride when it lands (post-parity;
it was never in the old extension).

## Status pills (permanent expert strip)

`channel · mic · rec · stream · video · ink · keys · ring · page · ipad` — claim statuses (stream/video/
ink/keys: idle → pending → active → error) and world facts (channel connection, mic
permission, iPad paint clients), stable labels, color = state. Internal detail deliberately
kept visible.
