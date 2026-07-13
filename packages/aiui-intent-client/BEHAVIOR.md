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

## Status pills (permanent expert strip)

`channel · mic · rec · stream · video · ink · keys · ipad` — claim statuses (stream/video/
ink/keys: idle → pending → active → error) and world facts (channel connection, mic
permission, iPad paint clients), stable labels, color = state. Internal detail deliberately
kept visible.
