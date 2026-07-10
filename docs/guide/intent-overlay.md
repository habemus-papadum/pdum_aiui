# Using the intent overlay

The intent overlay is the default modality of the [web intent tool](./web-intent-tool): a
floating widget over your app that collects a **multimodal turn** — dictation, pen ink,
region screenshots, on-screen selections — and streams it to the running channel, where it is
[lowered](./prompt-lowering) into a prompt for your Claude Code session. An optional
[**prompt linter**](./prompt-linting) — a realtime model — watches you compose and speaks up
at each pause. The overlay is the thing you reach for when "make *this* wider" is easier said
than typed. (A plain-text modality still exists under `format: "text-concat"`, but it left
the default widget when the overlay went multimodal-first.)

This page is **how to use it** — the keys, the turn lifecycle, the preview, and the knobs. The [Web Intent Tool](./web-intent-tool) page is the design (how the three pieces —
collection, lowering, debugging — fit together and how a modality plugs in); this page assumes
you already have the tool mounted (see [Getting Started](./getting-started)) and want to drive it.

![The intent overlay over a demo app](/intent-tool.png)

## Arming: the overlay stays out of your way until you call it

The overlay does nothing to your keyboard until you **arm** it. Arm and disarm with the
backtick key `` ` `` (or the **✳** arm button in the corner). While disarmed, every key belongs
to the page; while armed, the keymap below takes over — except that it never swallows keys aimed
at a text field (inputs, textareas, `contenteditable` editors like ProseMirror/CodeMirror/Monaco,
ARIA textboxes), so arming inside an editor-heavy app is safe.

Backtick is the default because it collides rarely, but it is not fixed: a host app can rebind
or disable keyboard arming through the pipeline config (`arming.key`, `arming.enabled` — see
[Configuring the pipeline](#configuring-the-pipeline)) when the default gesture is wrong for
its surface.

## The keymap

Minimalist by design — one hand, no chords:

| Key       | Action |
| --------- | ------ |
| `` ` ``   | arm / disarm the overlay (also the **✳** button on the pill) |
| **Space** | talk — push-to-talk, always a *hold* (toggling lives on **H**) |
| **H**     | hands-free talk — one press opens the mic, the next closes it |
| **M**     | mute / unmute the mic *without* ending the turn — the cough button. Offered only while the mic is open; the level meter dims and a 🔇 appears beside it |
| *drag*    | ink — no key; while armed, dragging draws. Strokes are **permanent** by default: they outlive the turn they were drawn in, and only **C** erases them |
| **D**     | hold + drag a rectangle = region screenshot |
| **S**     | whole-viewport screenshot (one press) |
| **C**     | clear ink — the only thing that does |
| **J**     | [VS Code jump mode](#vs-code-jump-mode-double-click-to-source) — double-click an element, pick a jump target (its source, or a containing cell), land in VS Code; **J** (or **Esc**) resumes |
| **V**     | share your screen — each sampled frame is a first-class screenshot (it joins the turn, and streams to the [prompt linter](./prompt-linting) when one is on); 🦉 smart / 🔫 continuous, toggled beside the ● badge |
| **N**     | mute / unmute the *share*, separately from the mic. The clock keeps ticking and every frame is dropped; unmuting captures one frame at the next tick, so the model sees where the screen ended up. Offered only while sharing |
| **K**     | quick config — the [strip](#quick-config-the-k-strip): tier digits, the **L** linter chip, save/reset, the editor |
| **T**     | [tweak mode](#tweak-mode-adjust-the-app-mid-turn) — hand the pointer and keyboard back to the app mid-turn; **T** (or **Esc**) resumes |
| **?**     | help — the whole keymap as a table (the pill's **?** icon is the mouse path to the same) |
| **Enter** | send — finalize and lower the turn |
| **Esc**   | step out one level (see the escape ladder below) |

**The two mutes are two keys on purpose.** Muting the screen while you keep narrating, and
narrating over a frozen screen, are both ordinary things to want; one key for both would make them
impossible. Neither mute survives its own subject: every talk window opens live, and every new
share starts unmuted — a mute you forgot is a recording you thought you were making.

### Ink: permanent by default, vanishing on request

The pill carries an **ink chip** where the mode name used to be (it read `ink`, which is the mode
you are in whenever you aren't in one of the two handovers — it never told you anything):

- **✒️ permanent** — the default. Strokes stay until **C**. They survive sending a turn, and they
  survive abandoning one with **Esc**. Ink is a drawing on the page, not a property of the turn
  that happened to be open when you drew it: a diagram you built to talk over should still be
  there while you talk about it.
- **💨 vanishing** — click the chip. A slider appears beside it: **1–10 s**, defaulting to **6**.

Vanishing ink does **not** dissolve steadily. For the first 80 % of a stroke's life nothing
happens at all — a stroke that begins dying the moment you draw it looks sick, and hides the one
moment worth seeing. Then it *charges*: still fully opaque, it thickens and heats toward white for
a beat (~0.7 s at 6 s). Then it pops, most of the disappearance landing in the last instants
(~0.5 s), stretching wider as it goes. A ship going to warp.

Flipping ✒️ → 💨 restarts every stroke's clock, so ink that has been sitting there for two minutes
gets the full fade you just asked for instead of vanishing in the next frame. Adjusting the
*duration* does not restart them — a stroke drawn 2 s ago, under a fresh 8 s fade, is
three-quarters opaque, not reborn. And a shot always freezes ink at full strength, mid-warp or
not: it captures what you circled, not a half-erased ghost.

**You never have to memorize this table.** While armed, a condensed **cheat sheet** floats above
the pill showing exactly the keys live in the *current* mode — key caps with a pictogram each,
labels on hover — so a handover mode shows only its two keys, the jump picker its four, and so
on. Both the cheat sheet and the **?** table are generated from the same declarative binding
rows the key resolver reads (the modal kit's hint column), so what they show and what the keys
do can never drift apart.

**A lit cap means that mode is on.** Any binding whose state is currently *engaged* — the share
is sampling, the mic is muted, tweak mode has the pointer — renders with a green ring
(`KeyHint.active`, reported by the binding itself). So "what of mine is switched on right now" is
readable at a glance rather than inferred from a label you have to hover to see. Green because
nothing else in the sheet is: the pill's ring is mode-coloured and the level meter is pink, so a
lit cap never reads as *recording*.

K is deliberately the only key configuration costs this layer: the tier digits, save, reset,
and the advanced editor all live *inside* the strip it opens, which shows its own bindings.

## A turn, start to finish

There is **no "begin" gesture**. A turn's *thread* opens implicitly on the first contentful
act while armed — a talk-start, an ink stroke, or a shot — and stays open as you add to it.
It closes when you:

- **Enter** — *send*: the accumulated turn is lowered and pushed into the session;
- **Esc** — *cancel*: the thread is dropped and nothing is sent (see the ladder);
- **auto-end** — an optional idle timeout (off by default) closes the thread after N silent
  seconds. Useful if you dislike reaching for Enter; risky if you pause to think mid-turn.

**The escape ladder.** `Esc` steps out exactly one level at a time, so a mis-step is one tap
to undo rather than a full reset: `tweak mode → ink`, `VS Code mode → ink`, then `cancel the
thread → disarm`. Press it until you're where you want to be — stepping out of tweak or VS
Code mode always lands back in composing, never straight at a cancel.

## Talking (dictation)

Hold **Space** and speak; releasing it ends the segment. Hold-to-talk is the default because a
key-release is a clean, pause-bounded segment boundary — exactly the unit speech-to-text wants —
and because a walkie-talkie key can't be left open by accident. Press-to-toggle is available as a
config choice if holding a key while you also draw or shoot feels awkward.

The transcript **preview** streams above the widget as you go, with shot thumbnails inline.
Transcription is **streaming**: partial deltas fill the preview *while you speak* (rendered
dim until the segment's final lands), and the final snaps in a fraction of a second after you
release Space. The preview is a **read-only render of the compiler's accumulator** — the same
fold (`composeIntent`) that produces the committed prompt — so what you see is what will be
sent, by construction. There is no transcript editor: a correction is *spoken* (see
[the append-only model](#corrections-are-spoken)).

## Ink

While armed, **dragging draws** — a quick circle around the thing you're talking about, no key
required. Ink is treated as a *gesture, not a document*: strokes fade after a few seconds
(configurable; set the fade to 0 to keep them until you press **C** to clear). The exception is a
screenshot: if a shot captures a region while your ink is still on screen, the stroke is
composited **into the PNG** and travels with the pixels it annotated.

## Screenshots

Hold **D** and drag a rectangle for a region shot, or press **S** for the whole viewport. The
two gestures live on separate keys on purpose: a bare tap and a fast drag are indistinguishable at
key-release, so folding both onto one key let a quick region drag also fire a whole-viewport shot.
The first shot of a session asks once for screen-capture permission — pick **"This Tab"** — and
every later shot is an instant frame grab.

Each shot also **locates the components** under its rectangle: the overlay hit-tests the captured
region against the source-location annotations your app carries (`data-source-loc`, i.e.
`file:line:col`, and `data-cell` dataflow ids — see [Frontend for Agents](./frontend-for-agents))
and records which components sit there. So a shot arrives at the session as *both* an image and a
list like `SpectrumPlot @ src/ui/plot.tsx:20` — the picture and the code that drew it.

If you deny capture (or the browser can't grant it), shots **degrade gracefully**: the turn still
carries the rectangle and the located components, just no pixels.

Every shot appears in the transcript preview as a yellow-outlined thumbnail: **hover** for a
full-size peek, and hover's **✕** retracts it from the turn — took the wrong screenshot, remove
it before sending. Retraction is an event like everything else (`shot-drop`), so the channel's
lowering drops the image too; the original shot stays visible in the trace.

**Shots land where you took them, not where the transcript caught up.** A shot taken
mid-sentence carries the gesture's wall-clock (`takenAt`); the compiler maps it onto the
segment's streaming-delta timeline and splits the text at that point (nudged to a word
boundary — and past a sentence end just ahead, where dictation pauses cluster), so the image
sits in the prose where you were speaking when you shot it — in the preview and in the
lowered prompt alike. Because transcript deltas *trail* the speech they transcribe, the
compiler compensates with a per-segment latency estimate measured from the stream itself
(how far the last delta trailed the release); it's an honest estimate, not ground truth —
per-word audio alignment is the open research direction.

## Corrections are spoken {#corrections-are-spoken}

The event stream is **append-only** and there is no transcript editor. If speech-to-text
mangles a word — or the [prompt linter](./prompt-linting) flags one — **say the fix**:
*"it's Vite, not beat."* The correction becomes new content the agent reads in context, which
in practice models handle at least as reliably as a silently-rewritten transcript — and the
trace shows exactly what was said, in order, with nothing rewritten after the fact.

(The earlier releases had a two-box transcript editor on **E** backed by a patch-writing
corrector model. It was removed in the append-only pivot: the editor's complexity — lassoed
spans, patch echoes, undo stacks — bought little over just speaking the fix, and it fought
the "preview = compiler accumulator" invariant. Historical traces containing `correction`
events still compose and render in the debugger.)

## Tweak mode: adjust the app mid-turn

An armed thread owns the pointer (drags ink) and most of the keyboard — but sometimes the turn
*needs* the app mid-composition: nudge a slider, click a button, select different text, then keep
talking about the result. Disarming would cancel the thread; **T** doesn't. It hands the pointer
and keyboard back to the app while the turn stays open — an **explicit handover**, not a
guessing game about which keys you meant for whom: in tweak mode the overlay claims only **T**
and **Esc** (both resume composing; Esc is the same one-rung step-out as leaving VS Code mode),
and *everything* else — Space, D, S, C, J, V, K, Enter, the strip digits — falls through to
the page. The pill's ring goes **dashed gray** while capture is released, so a glance tells you
the crosshair is gone on purpose. The thread and its channel socket stay open the whole time,
the idle auto-end timer (if you enable it) is suspended, and a selection you make while tweaking
rides the open turn as a `selection` update — adjust, re-select, press **T**, and finish the
same thought.

## VS Code jump mode: double-click to source

**J** enters the same kind of handover as tweak — pointer and keyboard go back to the app, the
pill's ring goes **dashed blue** — with exactly one gesture claimed for the overlay:
**double-click**. The click doesn't navigate; it opens the **jump picker**, a popup at the
click point listing everything that spot can jump to:

```
┌──────────────────────────────────────────┐
│ ELEMENT                                  │
│ ▸ 1 input     src/ui/Controls.tsx:42:7   │  ← nearest stamp, preselected
│   2 section   src/ui/Controls.tsx:12:3   │
│   3 div       src/App.tsx:8:5            │
│ CELL — DEFINED AT                        │
│   4 catalog   src/model/graph.ts:77      │
│   5 dashboard src/model/graph.ts:31      │
│ ↑↓ pick · 1–9 jump · ⏎ open · esc close  │
└──────────────────────────────────────────┘
```

- **Elements** are the stamped ancestors of what you clicked (`data-source-loc`), nearest →
  outermost: "which code authored this", at increasing levels of containment. The nearest is
  preselected, so double-click + **Enter** is still the one-beat fast path.
- **Cells** are the containing dataflow cells (`data-cell`), each at its **definition** site —
  the `cell(...)` call (`data-cell-loc`), not the JSX that renders its value (that JSX is
  already one of the element rows).
- **↑/↓** move the selection, **1–9** commit a numbered row directly, **Enter** commits,
  **Esc** dismisses (you stay in jump mode); clicking a row commits too. As the selection
  moves, the corresponding element's **bounding box lights up on the page** — containment stops
  being abstract, you see exactly which box each row is.
- **Misses are named, never silent.** An unstamped click still opens the picker, which says
  "no source location on or around this element"; a cell with no recorded definition shows
  grayed instead of vanishing.

Committing opens **VS Code at that file:line** — the `vscode://file/…` URL is computed on the
fly from the stamp and the dev server's source root, nothing precomputed. The jump takes you
*out of the browser* — VS Code steals focus — so the mode **ends itself on window blur**: when
you come back to the tab you're composing again, not still in a double-click trap you forgot
about. (Declared in the mode table as `blurExits`, the same declarative column that drives
cursors and the Esc ladder.) The turn survives the round trip exactly like a tweak excursion:
thread open, socket open, idle timer suspended.

Works best alongside the [VS Code extension](./vscode) — jumps land in the same editor that
sends selections back into the turn — but the mode itself needs only VS Code installed: the
`vscode://` URL scheme is handled by the editor directly.

## What runs where: the channel (real) vs mock

Transcription runs in one of two places, chosen by config. **The real, channel-side path is
the default**; mock is the explicit offline choice.

- **`openai-realtime` (channel-side) — the default.** The page streams PCM to a per-thread
  realtime session the channel holds open, and partial transcript deltas echo back **while you
  speak**; the final lands a fraction of a second after you release Space. The key lives with
  the channel — read from `OPENAI_API_KEY` in the environment `aiui claude` runs in, **never**
  from the page or `config.json` — and `aiui claude`
  [preflights it](./config#the-intent-pipeline-openai-key) at launch. If the channel has no key
  (or a stale one), the step does **not** silently fall back: the widget's status says
  transcription is *unavailable* and how to fix it. The overlay still mounts and everything
  else — ink, shots, composing, sending — keeps working. It needs the mic **and** an
  `AudioWorklet` (a context lacking either says so out loud — no silent fallback). Knobs:
  `realtimeModel` (per tier) and `realtimeDelay` (`minimal`…`xhigh`, a latency/accuracy
  trade-off).
- **`mock` (local, offline, no key) — for development.** Transcription streams canned phrases;
  nothing leaves the browser. It's the explicit offline/dev choice — set
  `transcriber: "mock"` — so the whole loop runs with no channel and no key. (It is deliberately
  not on the K strip; set it in config.)

(The pre-pivot REST transcriber — `transcriber: "openai"`, whole-segment uploads with a
~1–1.5 s floor and no partials — is retired from every tier; the value still resolves for old
persisted configs.)

When you **send**, the whole turn is lowered in the channel into a single prompt: the dictated
text and each screenshot **inlined at its position in the prose** as an
indented block —

```xml
<screenshot path=".aiui-cache/traces/…/shot_1.png">
  <element name="Legend" source="src/Legend.tsx:30:2">
    <cell name="colorScale" source="src/Legend.tsx:41:8"/>
    <cell name="ticks"/>
  </element>
</screenshot>
```

— the image's on-disk path, the components the drag framed, and their top-level dataflow cells
(paths and source locations relativized to the session's working directory when they live under
it). XML is the default because models attend reliably to tags while the indented form stays
readable; `shotFormat: "text"` in the intent config switches to a plain bracket block. Viewport
shots (S) render as a single self-closing tag with no element metadata. The
tab and source context that every intent submission carries (see
[the web intent tool](./web-intent-tool#what-rides-the-hello-tab-identity-and-source-location))
is prefixed just as it is for text. Every stage of that lowering is recorded as a **trace** you
can inspect in the debugger:

![The lowering debugger showing a multimodal trace](/lowering-debugger.png)

## Tiers: one dial for transcription

The pipeline has several model knobs — transcriber, models, TTS — and `tier` is a single
**cost-sized dial** over them. Transcription is streaming in both rungs; they differ by model
and whether anything is spoken back:

| `tier` | Backend | What you feel |
| --- | --- | --- |
| `rapid` *(default)* | `gpt-realtime-whisper` (streaming STT) | partials as you talk; the final snaps in well under a second. No voice back. |
| `premium` | `gpt-4o-mini-transcribe` over the same streaming endpoint + `gpt-4o-mini-tts` spoken acks | higher transcription quality, and it says "sent" back to you — eyes on the app, not the preview. |

`tier` defaults to `rapid` — an absent tier *is* rapid. A third, unsurfaced rung — `mock` —
exists for tests and offline development (set it in config; it has no strip digit).
[**Prompt linting**](./prompt-linting) is deliberately **not** a tier: it's an orthogonal
on/off + vendor switch (`linter`), so any tier can lint.

**The merge rule: preset first, then your explicit knobs.** The effective config is
`DEFAULT ← tier preset ← explicit fine fields` — the tier preset fills in over the defaults, and
your explicit fields (the Vite `intent` option unioned with any gear-panel/agent overrides) fill
in over the preset. A tier only *supplies* the fields it owns; anything you name explicitly still
wins. So `{ tier: "premium", realtimeModel: "gpt-realtime-whisper" }` keeps premium's spoken
acks but pins the model. Switching `tier` **re-derives** the fields that tier owns — you don't
inherit the old tier's fields frozen in.

**Setting it — four doors, one validated path.** Set `tier` any of the ways you set the other
knobs:

- the Vite option — `aiuiDevOverlay({ intent: { tier: "premium" } })`;
- the [**K strip**](#quick-config-the-k-strip) — a digit while armed, session-scoped;
- the gear (**⚙ advanced config**) panel — edit `tier` in the JSON;
- the agent's `aiui_overlay set_config` tool — `{ config: { tier: "premium" } }`.

All four go through the same validated config path.

**Retired rungs** (`standard`, `flagship`, `live-gemini`, `live-openai`) still *resolve* — an
old persisted config keeps meaning what it meant, with the channel translating the composer/
voice-era selections onto the linter world (the trace's `intent config` stage records every
such coercion). The model-composes "realtime submode" behind the old live tiers was removed
outright; see [Realtime Live Mode](./realtime-live) for the history and
[Prompt Linting](./prompt-linting) for what replaced it.

## Quick config: the K strip

Press **K** while armed and a small strip opens above the widget pill — the keyboard-speed door to the
tier dial, built for the "let me try this segment on `rapid`" moment when reaching for the Vite
config or the JSON editor would break your flow. The strip is its own documentation:

```
TIER   session — unsaved
[1 rapid] [2 premium]
[L 💡 linter: off]
S save for site · R reset to file · G editor · Esc close
```

- **1–2** pick a tier, cheapest first — the same ladder as the table above, so the digit *is*
  the price dial. The switch is **session-scoped**: it takes effect immediately but persists
  nowhere, and a reload returns you to the file (Vite) config plus whatever you saved earlier.
  Your explicit fine fields still win over the preset, exactly as everywhere else.
- **L** cycles the [prompt linter](./prompt-linting): **off → openai → gemini**. Orthogonal to
  the tier and session-scoped like a digit; a mid-thread change applies on the next turn (this
  thread's session is already running).
- **Mid-thread, the switch waits.** A thread's opening hello already told the channel which
  pipeline to run, so a tier picked while a thread is open applies **when that thread closes**
  (send or cancel) — the strip says so, and the next thread's hello carries it. No thread open →
  it applies on the spot.
- **S** saves the current config for this site (the same per-origin browser storage the gear
  panel writes, as the same minimal delta). **R** resets to the file config, clearing both the
  session layer and the saved one. **G** jumps to the fine-grained door: the gear panel's JSON
  editor over the full effective config.
- **Esc** (or **K** again) closes the strip — it never steps out of your turn. Everything
  unrelated keeps working while it's open: Space still talks, Enter still sends. Disarming
  closes it.

The layering, in full: `DEFAULT ← tier preset ← Vite intent ← saved overrides ← session`. The
strip's digits write only the last layer; **S** folds it into the saved one; **R** empties both.

**Degradation is loud — a paid feature never quietly downgrades.** A keyless `premium` says
*"spoken confirmation unavailable — no OPENAI_API_KEY (premium tier)"* rather than silently
becoming `rapid`; a keyless linter says which key is missing and that dictation still works.
Same posture the pipeline already takes for keyless transcription (see
[What runs where](#what-runs-where-the-channel-real-vs-mock)).

**What it feels like in practice** (measured live, 2026-07-05, against real OpenAI calls). On
`premium`, the spoken "sent" ack lands ~1.1 s after you send (~14 KB per ack); streaming
transcript finals land ~0.5–0.9 s after you release Space.

## Configuring the pipeline

Everything above is governed by one object, `IntentPipelineConfig`, deliberately **wider than
the visible UI**. It began, in the retired workbench lab, as a settings drawer — every contested
interaction choice as a knob — and survives here as a superset: the same knobs, plus research
knobs that ride along so they can be measured before they're designed for.

**Where the knobs live.** You set them in config, not through the widget. Client-side choices
(talk mode, ink fade, arming rebind, transcriber choice) ride the modality options —
`aiuiDevOverlay({ intent: { … } })` in your Vite config, or the `mountIntentTool` options
outside Vite. The fields the **channel** honors — `transcriber`, the models, `linter` and its
siblings, and the `passes` switches — travel to the server on the connection's hello, so the
lowering reads exactly the configuration the client declared and the trace records the whole
thing.

**Minimal visible UI, one power tool.** The shipping widget's visible surface is the arm button,
a state readout, a mic level meter, the transcript preview, a keymap reminder — and a gear
(**⚙ advanced config**) opening a raw-JSON editor over the *full effective* config. The editor is
strictly validated like `config.json` (an unknown key or wrong type rejects loudly, naming the
key — nothing is silently dropped), applies live where a knob is read dynamically (talk mode, ink
fade, arming rebind; transcriber/model changes take effect on the next talk), and persists
only your overrides per origin (reset clears them). The next thread's hello carries the effective
config, so traces always record what actually ran. A *curated* settings row of on-screen toggles
is still deliberately deferred — which knobs earn visible UI is exactly what the lab's T1–T7
dogfooding decides.

The knobs, with their defaults:

| Field | Default | What it does |
| --- | --- | --- |
| `tier` | `rapid` | The cost dial — one preset over the model knobs below; see [Tiers](#tiers-one-dial-for-transcription). |
| `talkMode` | `hold` | Space is hold-to-talk (`hold`) or press-to-toggle (`toggle`). |
| `inkFadeSec` | `6` | Seconds until ink fades; `0` keeps strokes until you clear them. |
| `autoEndSec` | `0` | Idle seconds before a turn auto-ends; `0` means explicit Enter only. |
| `transcriber` | `openai-realtime` | `openai-realtime` (channel-side streaming — the default; partials as you speak) or `mock` (local, offline). |
| `realtimeModel` | `gpt-realtime-whisper` | Streaming transcription model (`rapid`; `premium` sets `gpt-4o-mini-transcribe`). |
| `realtimeDelay` | *(model default)* | Streaming latency/accuracy trade-off: `minimal`…`xhigh`. |
| `audioBack` | `off` | Spoken audio back to you: `off` (silent) or `acks` (premium — short TTS confirmations). Also the client-side mute — set `off` to silence audio-back (including the linter's spoken notes) regardless of tier. |
| `linter` | `off` | The [prompt linter](./prompt-linting): `off`, `openai`, or `gemini`. |
| `linterModel` | *(vendor default)* | Linter model id (`gpt-realtime-2` / `gemini-3.1-flash-live-preview`). |
| `linterInstructions` | *(built-in persona)* | Replaces the [published linter persona](./prompt-linting#the-prompt). |
| `videoFrameIntervalMs` | `5000` | Screen-share cadence in ms per frame; the slider beside the ● badge writes it live. In smart mode it's the fastest frames can come, not a promise. |
| `videoMode` | `smart` | Screen-share capture mode: `smart` (🦉 — a frame only when you've interacted with the app since the last one) or `continuous` (🔫 — clockwork on the cadence). The toggle beside the ● badge writes it live. |
| `arming` | `{ key: "`", enabled: true }` | The arm/disarm key, and whether keyboard arming is on at all. |

The spoken-audio fields you normally never set by hand — `tier` fills them in — but they're
there to override one when you want: `ttsModel` (premium's TTS model, default
`gpt-4o-mini-tts`) and `ttsVoice` (its voice id); `realtimeVoice` also names the linter's
spoken voice on the OpenAI vendor.

Research knobs ship **without UI** and default off: `passes` (the lowering's condition/polish
slots — `silenceTrim`, `imageDownscale`), `silenceGate` (client-side dead-air trimming before a
segment is sent), and `priming` (keyword sources fed to the transcriber as a bias). They exist so
the pipeline is already shaped for behavior the lab is still measuring.

## See also

- [Prompt Linting](./prompt-linting) — the realtime observer, its verbatim persona, the
  `read_file` tool, and the cost model.
- [The Web Intent Tool](./web-intent-tool) — the design behind the overlay: modalities,
  lowering, traces, and how a modality plugs in.
- [The intent pipeline (OpenAI key)](./config#the-intent-pipeline-openai-key) — the key story
  and launch preflight.
- [Prompt Lowering](./prompt-lowering) — why lowering exists and where it's going.
