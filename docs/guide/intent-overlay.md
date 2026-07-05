# Using the intent overlay

The intent overlay is the default modality of the [web intent tool](./web-intent-tool): a
floating widget over your app that collects a **multimodal turn** — dictation, pen ink,
region screenshots, and a select-and-speak correction loop — and streams it to the running
channel, where it is [lowered](./prompt-lowering) into a prompt for your Claude Code session.
Text is still there as an escape hatch, but the overlay is the thing you reach for when
"make *this* wider" is easier said than typed.

This page is **how to use it** — the keys, the turn lifecycle, the correction loop, and the
knobs. The [Web Intent Tool](./web-intent-tool) page is the design (how the three pieces —
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
| `` ` ``   | arm / disarm the overlay (also the **✳ aiui** button) |
| **Space** | talk — *hold*-to-talk (default) or press-to-*toggle*, per config |
| *drag*    | ink — no key; while armed, dragging draws |
| **S**     | hold + drag = region screenshot · tap = whole viewport |
| **C**     | clear ink |
| **E**     | correct mode — select transcript text, then speak or type the fix |
| **Enter** | send — finalize and lower the turn |
| **Esc**   | step out one level (see the escape ladder below) |

## A turn, start to finish

There is **no "begin" gesture**. A turn's *thread* opens implicitly on the first contentful
act while armed — a talk-start, an ink stroke, or a shot — and stays open as you add to it.
It closes when you:

- **Enter** — *send*: the accumulated turn is lowered and pushed into the session;
- **Esc** — *cancel*: the thread is dropped and nothing is sent (see the ladder);
- **auto-end** — an optional idle timeout (off by default) closes the thread after N silent
  seconds. Useful if you dislike reaching for Enter; risky if you pause to think mid-turn.

**The escape ladder.** `Esc` steps out exactly one level at a time, so a mis-step is one tap
to undo rather than a full reset: `correct mode → ink → cancel the thread → disarm`. Press it
until you're where you want to be.

## Talking (dictation)

Hold **Space** and speak; releasing it ends the segment. Hold-to-talk is the default because a
key-release is a clean, pause-bounded segment boundary — exactly the unit speech-to-text wants —
and because a walkie-talkie key can't be left open by accident. Press-to-toggle is available as a
config choice if holding a key while you also draw or shoot feels awkward.

The transcript **preview** streams above the widget as you go, with shot thumbnails inline. How
live it feels depends on which transcriber runs (see [What runs where](#what-runs-where-mock-vs-the-channel)):
the mock streams word-by-word; the real REST transcriber has no partials, so the preview fills in
all at once when the segment's transcript lands.

## Ink

While armed, **dragging draws** — a quick circle around the thing you're talking about, no key
required. Ink is treated as a *gesture, not a document*: strokes fade after a few seconds
(configurable; set the fade to 0 to keep them until you press **C** to clear). The exception is a
screenshot: if a shot captures a region while your ink is still on screen, the stroke is
composited **into the PNG** and travels with the pixels it annotated.

## Screenshots

Hold **S** and drag a rectangle for a region shot, or tap **S** for the whole viewport. The
first shot of a session asks once for screen-capture permission — pick **"This Tab"** — and every
later shot is an instant frame grab.

Each shot also **locates the components** under its rectangle: the overlay hit-tests the captured
region against the source-location annotations your app carries (`data-source-loc`, i.e.
`file:line:col`, and `data-cell` dataflow ids — see [Frontend for Agents](./frontend-for-agents))
and records which components sit there. So a shot arrives at the session as *both* an image and a
list like `SpectrumPlot @ src/ui/plot.tsx:20` — the picture and the code that drew it.

If you deny capture (or the browser can't grant it), shots **degrade gracefully**: the turn still
carries the rectangle and the located components, just no pixels.

## The correction meta-loop

Speech-to-text mangles domain words — and the overlay makes fixing them a first-class gesture
rather than a retype. Press **E** to enter correct mode: the preview expands and the transcript
becomes **selectable text**. Select the wrong words with an ordinary text selection (no special
gesture), then either **speak** the fix (the next segment auto-submits as the correction when it
ends) or type it into the inline box.

A correction is a **patch, not a string replace** — which is what lets it be smarter than
"swap these characters." The transcript (one segment per line), your selection, and the
instruction go to the corrector, which answers with a diff; the overlay flashes the change
inline (pink deletions, green additions) for a beat, then settles on the clean text. Two things
follow from corrections being patches:

- **The corrector reads two instruction modes.** A *replacement* is verbatim content for the
  selected span — select "curb", say "curve", the span is swapped and nothing else is touched.
  A *description* instead *talks about* the change — *"no, it's not beat, it's Vite, the
  frontend build tool."* Here the selection is only the example occurrence: the corrector infers
  the intended edit, fixes **every** affected occurrence across the whole transcript, and uses the
  explanatory context (that it's spelled "Vite", that it's a build tool) without letting it leak
  into the text.
- **Corrections compound and never silently vanish.** Each fix patches the *already-corrected*
  transcript, so a later correction can target text an earlier one produced. If a patch can't be
  produced or won't apply, the overlay falls back to a plain replacement of the selected text —
  the correction still lands.

## What runs where: mock vs the channel

The two model-backed steps — transcription and the correction diff — each run in one of two
places, chosen by config:

- **`mock` (local, offline, no key).** The default. Transcription streams canned phrases (with
  injectable typos, so the correction loop has something to fix) and corrections are built
  locally. Nothing leaves the browser and no API key is needed — this is the mode to design and
  demo against.
- **`openai` (channel-side).** The real thing runs in the **channel process**, not the page:
  when a talk segment or a correction request reaches the channel, it calls OpenAI and echoes the
  result back to the widget to merge into its preview. The key lives with the channel — it is read
  from `OPENAI_API_KEY` in the environment `aiui claude` runs in, **never** from the page or
  `config.json`. `aiui claude` [preflights that key](./config#the-intent-pipeline-openai-key) at
  launch, and a missing or stale key **degrades** transcription/correction to mock/off rather than
  blocking anything — the overlay still mounts and works.

When you **send**, the whole turn is lowered in the channel into a single prompt: the dictated
text, the corrections applied, and each screenshot placed at its position in the prose as a
`{shot_N}` token, with the image's on-disk path carried alongside so the session can open it. The
tab and source context that every intent submission carries (see
[the web intent tool](./web-intent-tool#what-rides-the-hello-tab-identity-and-source-location))
is prefixed just as it is for text. Every stage of that lowering is recorded as a **trace** you
can inspect in the debugger:

![The lowering debugger showing a multimodal trace](/lowering-debugger.png)

## Configuring the pipeline

Everything above is governed by one object, `IntentPipelineConfig`, deliberately **wider than
the visible UI**. It began as the workbench's settings drawer — every contested interaction
choice as a knob — and graduates here as a superset: the same knobs, plus research knobs that
ride along so they can be measured before they're designed for.

**Where the knobs live.** You set them in config, not through the widget. Client-side choices
(talk mode, ink fade, arming rebind, transcriber/corrector choice) ride the modality options —
`aiuiDevOverlay({ intent: { … } })` in your Vite config, or the `mountIntentTool` options
outside Vite. The fields the **channel** honors — `transcriber`, `model`, `corrector`,
`correctionModel`, `correctionPolicy`, and the `passes` switches — travel to the server on the
connection's hello, so the lowering reads exactly the configuration the client declared and the
trace records the whole thing.

**Minimal visible UI, one power tool.** The shipping widget's visible surface is the arm button,
a state readout, a mic level meter, the transcript preview, a keymap reminder — and a gear
(**⚙ advanced config**) opening a raw-JSON editor over the *full effective* config. The editor is
strictly validated like `config.json` (an unknown key or wrong type rejects loudly, naming the
key — nothing is silently dropped), applies live where a knob is read dynamically (talk mode, ink
fade, arming rebind; transcriber/corrector changes take effect on the next talk), and persists
only your overrides per origin (reset clears them). The next thread's hello carries the effective
config, so traces always record what actually ran. A *curated* settings row of on-screen toggles
is still deliberately deferred — which knobs earn visible UI is exactly what the lab's T1–T7
dogfooding decides.

The knobs, with their defaults:

| Field | Default | What it does |
| --- | --- | --- |
| `talkMode` | `hold` | Space is hold-to-talk (`hold`) or press-to-toggle (`toggle`). |
| `inkFadeSec` | `6` | Seconds until ink fades; `0` keeps strokes until you clear them. |
| `autoEndSec` | `0` | Idle seconds before a turn auto-ends; `0` means explicit Enter only. |
| `transcriber` | `mock` | `mock` (local) or `openai` (channel-side transcription). |
| `model` | `gpt-4o-mini-transcribe` | OpenAI transcription model (when `transcriber: openai`). |
| `correctionPolicy` | `replace` | A correction rewrites the transcript (`replace`) or rides along as a note for the lowering model (`note`). |
| `corrector` | `mock` | `mock` (local patch) or `openai` (a chat model writes the diff). |
| `correctionModel` | `gpt-4o-mini` | Chat model that emits the correction patch (when `corrector: openai`). |
| `arming` | `{ key: "`", enabled: true }` | The arm/disarm key, and whether keyboard arming is on at all. |

Research knobs ship **without UI** and default off: `passes` (the lowering's condition/polish
slots — `silenceTrim`, `imageDownscale`), `silenceGate` (client-side dead-air trimming before a
segment is sent), and `priming` (keyword sources fed to the transcriber as a bias). They exist so
the pipeline is already shaped for behavior the lab is still measuring.

## See also

- [The Web Intent Tool](./web-intent-tool) — the design behind the overlay: modalities,
  lowering, traces, and how a modality plugs in.
- [The intent pipeline (OpenAI key)](./config#the-intent-pipeline-openai-key) — the key story
  and launch preflight.
- [Prompt Lowering](./prompt-lowering) — why lowering exists and where it's going.
