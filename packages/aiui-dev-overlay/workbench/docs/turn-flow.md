# The turn flow: an evaluator's guide

*You're about to use the lab to **judge and measure** the multimodal interaction design. This
page tells you how to run it, exactly what's real vs simulated, which toggles exist and what
design question each one answers, and a walkthrough that exercises everything. How to **use** the
shipping overlay (the same gestures, in a real app) is the guide page
([docs/guide/intent-overlay.md](../../../../docs/guide/intent-overlay.md)) — this page is the
lab's measurement companion, not a duplicate of it.*

## Running it

```sh
pnpm workbench        # from the repo root — starts the vite dev server
```

Open the printed URL (default `http://localhost:5173`) **in Chrome** — the workbench is
Chrome-first (`caretRangeFromPoint`, `preferCurrentTab` capture; Safari/Firefox untested).

Optional, for real transcription: put your key in the repo-root `.env.dev` (gitignored):

```
OPENAI_API_KEY=sk-…
```

The file **wins over a shell-exported key** so a stale export can't shadow it. No key → the
`openai` transcriber returns a clear error and the mock remains fully usable.

Two permission prompts you'll meet, each once per session:
- **Microphone** on your first talk (only matters for the `openai` transcriber — the mock never
  reads audio, so denying the mic still leaves the whole flow usable).
- **Screen capture** on your first screenshot — pick **"This Tab"**. Every later shot is an
  instant frame grab. Denying it degrades gracefully: shots still carry the rect + located
  components, just no pixels.

## What is real, what is simulated, what is absent

| Piece | Status |
| --- | --- |
| Keymap, modes, thread lifecycle | **Real** — the design under test |
| Ink (draw / fade / clear / freeze-into-shot) | **Real** |
| Region + viewport screenshots | **Real pixels** via one-time tab capture; PNGs persist to `$TMPDIR/aiui-workbench/` so the lowered prompt carries genuine absolute paths |
| Component locator (rect → `data-comp`/`data-source`) | **Real mechanism, staged target** — the scenery annotates itself the way a locator vite plugin would annotate a real app |
| `mock` transcriber (default) | **Simulated** — canned phrases streamed word-by-word, with injectable typos; ignores the audio entirely |
| `openai` transcriber | **Real and wired** — mic → MediaRecorder → dev-server proxy → OpenAI (`gpt-4o-mini-transcribe` by default). Verified end-to-end with synthesized speech; the only leg not yet exercised by a human is a live microphone, which is part of what you're evaluating |
| Transcript preview + correction meta-loop (E) | **Real** — select the preview text, speak or type the fix; corrections run through an **LLM diff micro-pipeline** (mock corrector by default; `gpt-4o-mini` emits a V4A patch when `corrector: openai`) with a pink/green inline diff flash on apply |
| Debug panes (events / IR / timing / export) | **Real, and shared** — the `debug-ui` panes the DevTools extension also embeds; IR stages recompute live; S3 emits the Option-C body+meta encoding with hover-previewable paths |
| Channel / Claude injection | **Absent in the lab, by design** — the shipping overlay streams the thread to the channel (that's what graduated); the lab stays standalone, so Enter "sends" only in the sense of closing the thread. Nothing reaches any session |
| Streaming/realtime STT, silence gating, audio-back, keyword priming | **Not built** — see [the audio-stack notes](./openai-audio-stack.md) for the plan |

## The interaction design under test

The keys, as a quick reference while you evaluate — the full interaction rationale (thread
lifecycle, why ink is gestural, the correction meta-loop and its two instruction modes) now
lives in the [guide page](../../../../docs/guide/intent-overlay.md); it isn't repeated here:

| Key       | Action |
| --------- | ------ |
| `` ` ``   | arm / disarm the overlay (also the ✳ button, bottom-left) |
| **Space** | talk — *hold*-to-talk (default) or press-to-*toggle*; a setting, on purpose |
| *drag*    | ink — no key; while armed, drawing is the default gesture |
| **S**     | hold + drag = region screenshot · tap = whole viewport |
| **C**     | clear ink |
| **E**     | correct mode — select transcript text, then speak/type the fix |
| **Enter** | send: finalize the thread |
| **Esc**   | step out one level: correct → ink → cancel thread → disarm |

What matters for evaluation: a thread opens on the first contentful act and closes on Enter/Esc;
ink fades (a setting) unless a shot freezes it into the pixels; and the correction meta-loop
(`E` → select the wrong words → speak or type the fix → V4A-patch diff flash) is the layer's
most novel bet. The toggles below and the walkthrough are where you put each of those under load.

## The toggles, and the question each one answers

Settings live in the drawer at the bottom of the right dock, persisted to `localStorage`
(clear site data to reset). Every contested design choice is a toggle so it gets settled by
use, not argument:

| Setting | Values (default) | The question it exists to answer |
| --- | --- | --- |
| `space bar` | **hold** / toggle | Is walkie-talkie PTT right, or does holding a key while drawing/shooting grate? Toggle risks forgotten-open mics; hold produces exactly the pause-bounded segments REST STT wants. |
| `ink fade (s)` | **6** / 0 = keep | Are annotations gestures (should evaporate) or documents (should persist until cleared)? Watch whether you ever *miss* faded ink. |
| `auto-end thread (s)` | **0 = off** | Should silence end a turn, or is explicit Enter the only trustworthy close? Try 5–8 s and see if it ever fires when you were merely thinking. |
| `transcriber` | **mock** / openai | Design against the mock; judge *felt latency* against openai. |
| `openai model` | **gpt-4o-mini-transcribe** | Swap in `whisper-1` / `gpt-4o-transcribe`; the timing pane records every segment. |
| `mock: ms/word` | **140** | Simulated streaming cadence — how slow can the preview be before it stops feeling live? |
| `mock: typo rate` | **0.07** (set to 1 when testing corrections) | Guarantees material for the correction loop. |
| `correction policy` | **replace** / note | Should a fix rewrite the transcript, or ride along as an instruction for the lowering model? Compare S2/S3 in the IR pane under each. |
| `corrector` | **mock** / openai | Local instant replace-patch vs a real LLM writing the diff — is the model's ability to fix beyond the selection worth ~2 s? |
| `corrector model` | **gpt-4o-mini** | The patch-writing model; latency shows in the timing pane as `diff` rows. |

## Evaluation walkthrough

Watch the right dock throughout — **events** is the raw stream, **ir** recomputes the lowering
on every event, **timing** records each transcription.

1. **Basic dictation (mock).** Arm (`` ` ``), hold **Space**, speak (or don't — the mock doesn't
   care), release. Watch: preview streams word-by-word; `talk-start/-end`, deltas, and a `FINAL`
   with latency land in events; the timing pane gains a row. *Judge: does the segment boundary
   at key-release feel right?*
2. **Toggle mode.** Settings → space bar → toggle. Repeat. *Judge: which do you stop thinking
   about first? Did you ever leave the mic open?*
3. **Ink.** Drag a circle around the legend. Watch it fade (~6 s). Draw again, press **C**.
   Set fade to 0 and see if persistent ink earns its clutter. *Judge: gesture or document?*
4. **Shots + locator.** Hold **S**, drag a rect over the plot; grant "This Tab" once. Watch: a
   thumbnail lands inline in the preview; the shot event lists located components
   (`SpectrumPlot @ workbench/src/scenery.ts:20`); the IR pane's S3 shows `{shot_1}` in the body
   and a `shot_1 = /…/aiui-workbench/…png` meta row — **hover the path to peek the image**,
   click to open. Circle something in ink first and shoot it: the ink is burned into the PNG.
   Tap **S** without dragging for a viewport shot.
5. **The correction meta-loop.** Set `mock: typo rate` to 1 (guaranteed mangles: "curve"→"curb",
   "amber"→"ember"…). Talk. Press **E** — the preview expands. **Select** a mangled word; it
   highlights; the correction bar opens. Type the fix and Enter — or hold Space and *say* it
   (auto-submits when the segment ends). Watch the pink/green diff flash, then the clean text;
   S2 gains `✓ "curb" → "curve"`; the timing pane gains a `diff` row. Flip `corrector` to
   `openai` and repeat — now `gpt-4o-mini` writes the patch (~2 s; try an instruction that
   implies a broader fix, like selecting one "curb" and saying "curve, both places"). Then flip
   the policy to `note` and compare S3. *Judge: is one-meta-level-down with the same gestures
   learnable? Is the ~2 s LLM correction worth it over local replace?*
6. **Real transcription.** Key in `.env.dev`, settings → transcriber → openai. Speak into a real
   microphone. Expect ~1–1.5 s from release to final (the REST floor; there are no partials, so
   the preview fills all at once). *Judge: is pause-bounded REST latency acceptable for the
   preview, or does this flow need streaming (L1)?* This is the highest-value thing only a
   human evaluator can do — the mic leg has never been exercised live.
7. **Lifecycle + escape ladder.** **Enter** to send (thread-close `send`; preview clears on next
   thread). Start another thread, **Esc** through the ladder: correct → ink → cancel → disarm.
   Try `auto-end 5` and see whether the timeout ever surprises you.
8. **Export.** The export button downloads the whole event stream as JSON — this is the fixture
   format future IR passes will be tested against; eyeball that it reads like a faithful record
   of what you did.

## Known rough edges

- Chrome-only, desktop-only; no touch/stylus tuning yet.
- The capture veil dims the screen while S is held — the captured frame waits ~120 ms for the
  veil to drop, so very fast S-tap sequences can race it.
- REST transcription has no partials: with `openai` selected the preview is silent until the
  final lands (that's the L0 limitation, not a bug).
- Shot PNGs accumulate in `$TMPDIR/aiui-workbench/` — the OS cleans temp eventually; nothing
  else does.
