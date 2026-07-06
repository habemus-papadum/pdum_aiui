# Modal interaction surfaces: lessons from the intent overlay

*(July 2026. Written for aiui-viz — the visualization framework — after a long interactive
debugging run on the overlay's modal system in `aiui-dev-overlay`: the armed/ink/correct modes,
the D/S screenshot split, hands-free dictation with silence endpointing, the two-box correction
editor, and stream-level undo. This is a retrospective, not a spec: what we built, which bugs
the design invited, and — the point — how to structure the same pattern in viz apps so those
bug classes can't recur. The overlay work itself lives in
`packages/aiui-dev-overlay/src/{intent-pipeline,multimodal}/`; its broader plans are in that
package's `handoff/pipeline-and-interaction-model.md`.)*

## 1. The trivial ask first: reusing the diff-flash

`aiui-dev-overlay/src/multimodal/diff-flash.ts` is deliberately framework-free and small:

- `renderRuns(runs)` / `runsFragment(before, after)` — word-level LCS diff (from the shared
  `wordDiff`) rendered as spans styled `mm-diff-del` / `mm-diff-add`;
- `LiveDiffText` — a live text line where *extensions* render instantly and *revisions* flash
  the diff then settle (the anti-strobe rule: only rewrites animate, appends never do).

To reuse in aiui-viz, the honest move is to lift `wordDiff` + `diff-flash.ts` into a shared
home (aiui-util, or a new `@habemus-papadum/aiui-ui-bits`) rather than importing viz ← overlay
(wrong dependency direction; the overlay should eventually import it *from* the shared home).
Two couplings to break at extraction time: the `mm-` class-name prefix (make the two class
names constructor options with the current defaults), and the settle timing (already injectable
via `flashMs`; keep the 450/750 ms house defaults somewhere shared so all surfaces animate at
one tempo). Everything is jsdom-testable today (`diff-flash.test.ts` is the template) — keep
that property; it is why this piece never regressed while everything around it churned.

One design rule worth carrying with it: **one visual language for "this text changed in front
of you."** Corrector patches, streaming-STT self-revisions, undo restores, and manual-edit
folds all flash through the same runs renderer. The moment two surfaces animate changes
differently, users stop trusting either.

## 2. What we built, and what was actually good

The overlay's core is an **append-only event stream** (`IntentEvent[]`), a small state machine
(`Engine`), a **pure fold** from stream → composed output (`composeIntent`), and a **pure
keymap decision function** (`keyCommand(state, key, phase, repeat) → command | undefined`).
UI surfaces dispatch commands and re-render from state.

The scorecard after ~15 real bugs: **essentially none were in the pure core.** The fold, the
keymap function, the patch applier — table-driven tests, iterated three times through major
semantic redesigns (the correction mode changed its Enter/Esc meaning *three times* in one
day) at low cost. Every bug lived in the **shell**: DOM event handlers, async timing, focus,
media capture, cursors, pointer-events. That ratio is the whole argument for the architecture
below: the pattern is not "use a state machine," it is **grow the pure core until the shell is
too thin to hide bugs in.**

Two core ideas earned their keep and should be considered load-bearing for any viz modal work:

- **State = fold(events); UI = projection.** Because *everything* — mode changes, retractions,
  undo — is an event, we got for free: traces that show the full interaction history, replay
  for turn recovery, and a server that recomputes the same fold and therefore always agrees
  with the client. When we needed undo, it was one new event type (`correction-undo`) popping
  the fold's correction stack — not a parallel rollback mechanism that could drift.
- **Undo/retraction as append-only events, never local rollback.** The shot-✕ (`shot-drop`)
  and Escape-abort both work this way. Any viz app whose interaction state is shared with an
  agent/server should treat "take that back" as data, or the two sides *will* disagree.

## 3. The bug catalog, distilled to rules

Each of these cost a real debugging round. The rule is the part to keep.

1. **Never disambiguate gestures by event arrival order.** S once meant both "tap = viewport
   shot" and "drag = region shot," decided by whether pointerup beat keyup. On a fast drag it
   fired both. Distinct gestures get distinct triggers (D drag / S tap), full stop.
2. **A modal keymap must explicitly claim-or-pass every key event — including repeats and
   keyups — and claiming must not read state that lags an async action.** Held-Space repeats
   arrived while mic acquisition was still in flight (`talking` not yet true), mapped to
   nothing, went unprevented, and scrolled the page. The fix is a first-class inert command
   (`swallow`): "claimed, do nothing." If your keymap's default answer for an armed-mode key is
   `undefined`, you have this bug somewhere.
3. **Releases must be unconditional and idempotent.** Auto-splitting a held key into utterance
   segments means the release can land in the gap where nothing is "on"; a release that only
   fires when `talking` left the mic re-arming after the hand was off the key. "Key up always
   emits end; end is a no-op if nothing is running."
4. **Anything keyed to key-*up* needs a `window blur` fallback.** The getDisplayMedia picker
   stole focus mid-D-hold; the keyup never arrived; a full-viewport crosshair veil stranded
   over the page, immune to disarm. Focus steals (permission dialogs, cmd-tab) eat keyups
   routinely.
5. **Render is reconciliation: enforce surface invariants from state on every event.** The
   durable fix for the stranded veil was not better transition bookkeeping but a line in the
   per-event render pass: *not armed+ink ⇒ veil hidden.* One missed transition then costs a
   frame, not a wedged UI. Every mode-dependent surface (overlays, pointer-events, cursors)
   should be asserted this way, not toggled imperatively at transitions.
6. **Async completions re-validate mode at completion time.** A screenshot that resolved after
   the picker (seconds later) landed in a turn that had already been sent, haunting the next
   one. Launch-time checks are worthless for slow effects; check `armed`/mode again when the
   result arrives, and drop stragglers.
7. **Modal predicates need the semantically-right signal, not a proxy.** "Is the user
   mid-utterance?" is not "is the mic open" — hands-free listening keeps the mic open through
   silence, so empty-Enter wedged waiting for a transcript that would never come. We had to
   expose `heard` (has *this segment* detected voice) as its own signal. When a predicate
   misbehaves, suspect that it's a proxy.
8. **Dangerous global gestures must be re-bound at the keymap level inside editing modes.**
   Enter meant "send the whole turn to the agent" globally; from correct mode, a stray Enter
   fired the prompt mid-edit. The fix is in the pure keymap (`mode === "correct"` → Enter can
   never mean send), not in hoping focus sits in the right input.
9. **One event-capture owner.** The keymap listens on `document` in the capture phase, so
   component-level `stopPropagation` cannot defend against it. The contract that works: the
   keymap yields to typing targets (via `composedPath` so shadow DOM inputs count), and
   components never fight the keymap. Known holes to document per app: widgets handling keys
   on non-editable elements, and iframes (unreachable, hence naturally safe).
10. **Cursors are part of the mode contract.** A mode-wide crosshair (`body.mm-armed`) leaked
    into a keyboard-driven config strip and made its (then non-clickable) chips read as
    *broken buttons* — the user concluded the feature didn't work. Every surface asserts its
    own cursor; everything visually button-like must be actually clickable, routed through the
    same dispatch as its key.
11. **Media capture is its own hazard class.** `getUserMedia` blocks forever on an unanswered
    permission prompt (never gate the interaction loop on it; only acquire when the active
    config actually needs audio); `getDisplayMedia` consent is never persisted and its picker
    steals focus (see #4); mic permission is per-origin and every dev port is an origin (we
    pre-answer via session-browser launch flags); REST transcription needs an utterance
    boundary that hands-free UIs must synthesize (browser-side silence endpointing off the
    level meter — chosen over server VAD because it covers the non-realtime tiers too). Put
    capture behind seams (`PcmSource` is the model) so jsdom tests inject fakes.

## 4. If we did it again: the shape of a reusable modal kit

The overlay grew these pieces implicitly. For aiui-viz, build them explicitly, in this order:

1. **A mode machine as data.** States, transitions, and per-mode surface table:
   `mode → { keymap layer, cursor, pointer routing, entry/exit effects, Esc-parent }`.
   Pure, serializable, and — critically — mode changes are *events in the app's stream*, so
   traces show them and replay reproduces them. The `Esc-parent` column gives you the escape
   ladder mechanically instead of by hand-written `stepOut()` logic.
2. **Keymap layers with exhaustive claims.** A base layer per mode plus pushable layers
   (config strips, dialogs — the overlay's K-strip proved "layer, not mode" is a real and
   useful distinction: a layer claims a few keys and lets everything else keep its meaning).
   Each binding declares its repeat and keyup policy declaratively; each *layer* declares a
   default (`pass` | `swallow`) so rule #2's exhaustiveness is structural, not remembered.
   Resolution is top-down through the stack; the result is a pure function you table-test.
3. **Commands as the only side-effect boundary.** Keys, clicks, and agent tool calls all
   dispatch the same commands (the config strip's click handlers routing through the keymap's
   dispatch was the cheap, correct fix). UI never mutates state directly.
4. **Effects that report back as events and re-validate on completion.** Mic acquisition,
   captures, model round-trips: launch from a command, deliver results as events, and let the
   fold decide whether the result still belongs (rule #6). Timeouts are part of the effect
   (the "applying fix…" spinner has a ceiling; the Enter-waits-for-transcript has a ceiling)
   so no mode can wedge on a promise.
5. **A reconciler pass** that runs after every event and asserts the mode table's surface
   invariants (rule #5). This is also your best property test: "for every reachable state,
   surfaces match the table."
6. **Focus as tracked state** (`lastFocus`), not as a DOM query at decision time — it decides
   where dictation folds in, and DOM focus lies during transitions. Tab order inside a modal
   editor is an explicit two-stop hop, not native tab flow.

**Convention to hold constant across all apps** (users build muscle memory across
visualizations): **Esc** steps out one level / aborts the current scope and is never
destructive beyond that scope; **Enter** commits the current scope — with content it commits
the content, empty it closes the scope — and never reaches through to an outer scope's
destructive action. Mode entry announces itself visibly (border/ring color proved the right
peripheral signal; a text label alone is not enough).

## 5. Testing playbook (how submodes grow without regressions)

- **Table-test the pure keymap**: state × key × phase × repeat, asserting the command —
  including the swallow/pass rows. Every new submode adds rows, not new test machinery.
- **Adversarial event *orderings*, not just sequences.** The regression test that matters most
  in this codebase mounts the real surface and replays "pointerup arrives before keyup" — the
  fast-drag race. Async modal bugs are ordering bugs; test the orderings you fear.
- **Injected seams for everything the browser owns**: fake sockets, fake PCM sources, stubbed
  `getDisplayMedia`/canvas, injectable clocks on flashes. The whole overlay suite runs in
  jsdom; the few things jsdom lacks (`setPointerCapture`, layout rects) get one-line stubs.
  If a piece can't be driven this way, it's in the shell — shrink it.
- **Fixture streams as the contract.** Captured event logs replayed through the fold pin
  behavior across refactors, and double as the wire contract with the server side.
- **Mocks whose "level" is silence** (the mock transcriber's meter reads 0) keep timing-driven
  features (silence endpointing) inert in tests — deterministic by construction, no flaky
  timers. Design every timing feature with a "never fires under test" configuration.

## 6. Honest residue

Things we knowingly left imperfect, so the next design doesn't inherit them as invisible
constraints: the overlay's mode state is still scattered booleans (an explicit `UiMode` is
planned — see the overlay handoff's WP2 — and #4's mode-table subsumes it); shot thumbnails
don't render while the correction editor is open (the editable-document view is a plain
textarea); a manual edit can't create text when the document is empty (patches can't create
ex nihilo); and corrector diffs flash in a strip rather than inline because a textarea can't
render colored runs — a contenteditable-based document view would fix both of the last two,
at the cost of re-entering the hardest DOM territory there is. Budget for that decision
deliberately if viz apps need rich in-document editing.
