# Prompt Linting

Composing a good briefing for a coding agent is harder than it feels. You talk for a minute,
attach two screenshots, select a title on the page — and the compiled prompt quietly contains a
mistranscribed word ("beat" for "Vite"), a deictic reference no agent can resolve ("make *this*
slider wider" — you discussed two sliders), and a feature you described at length but never
showed. You find out after the agent has spent five minutes going the wrong way.

The **prompt linter** is a realtime model that watches you compose and speaks up at each pause —
one or two short sentences, choosing the single most useful observation. It hears your voice
live, sees your screen (while you share), receives every labeled screenshot and selection, and —
crucially — is shown the **exact transcription the compiler will use**, so it can flag where the
text contradicts what you plainly said.

The linter never writes the prompt. The compiler (`composeIntent`) assembles the briefing
verbatim from what you said and attached, in every configuration; the linter is purely advisory.
Its observations arrive as speech (if audio-back is on) and as 💡 chips in the transcript
preview — dismissible, never part of the prompt.

## Turning it on

Linting is orthogonal to the transcription tier — it is an on/off switch plus a vendor:

- Press <kbd>K</kbd> to open the config strip, then <kbd>L</kbd> to cycle
  **off → openai → gemini**.
- Or set it in config: `linter: "off" | "openai" | "gemini"` (plus `linterModel` to override the
  vendor default — `gpt-realtime-2` / `gemini-3.1-flash-live-preview` — and `linterInstructions`
  to replace the persona below).
- The vendor's API key must be present in the channel's environment (`OPENAI_API_KEY` /
  `GEMINI_API_KEY`). A missing key disables the linter **loudly** — one error naming the fix —
  and dictation keeps working.

While the linter is on, <kbd>V</kbd> shares your screen. Each sampled frame is a **first-class
screenshot** — it lands in the transcript preview at the moment it was taken, compiles into the
prompt there (annotated with its capture mode, and in machine-gun mode its offset from the
share's start), and reaches the linter labeled like a <kbd>D</kbd>/<kbd>S</kbd> shot. Two
controls appear beside the **● video** badge:

- the **🦉/🔫 mode toggle** — 🦉 *smart* (default) samples only when you've interacted with the
  app since the last frame (a still screen sends nothing); 🔫 *continuous* samples clockwork on
  the cadence. Config: `videoMode: "smart" | "continuous"`.
- the **cadence slider** — the tick interval, 500 ms – 10 s per frame (default 5 s). Config:
  `videoFrameIntervalMs`. In smart mode it is the *fastest* frames can come, not a promise.

Turning the share on always sends one immediate frame — the same as pressing <kbd>S</kbd> as
you start.

## What the linter sees, exactly

Everything the linter receives is bracketed, labeled, and recorded:

- **Your voice**, streamed live (the same microphone audio the transcriber gets).
- **Labeled screenshots** — `[image shot_3]` followed by the image. A share's sampled frames
  arrive exactly this way too — a frame *is* a shot, so the linter can cite it by id.
- **Selections** — `[selection sel_2: "gradient stops" — on-screen selection authored at
  src/Legend.tsx:41:8]`; an update reuses the id (`[selection sel_2 updated: …]`), a retraction
  says `[selection sel_2 retracted — disregard it]`.
- **The compiler's transcription** — when you pause, the channel waits (up to 2.5 s) for that
  segment's transcript, injects `[transcript seg_4: "make the curb wider"]`, and only then lets
  the linter speak. The lint judges what the *agent* will read, not just what the model heard.

The linter may also call one tool, **`read_file`**: any readable path, resolved against the
project root, capped at 32 KB, binary-sniffed — meant for verifying a suspicion ("that function
is named `curb`, not `curve`") before flagging it. Every call and every byte it read is recorded
in the turn's trace; nothing the linter saw is invisible.

Everything above — notes, tool calls, tool results, transcript injections, frames — appears in
the [trace debugger](./devtools.md) under the 💡 **linter** filter chip, with per-response cost
accounting.

## The prompt

This project's principle is that **every prompt we send is documented**. The linter's persona,
verbatim (`LINTER_INSTRUCTIONS` in `packages/aiui-claude-channel/src/live-session.ts`; a
`linterInstructions` config override replaces it):

> You are a realtime prompt linter. You are observing a person compose a task briefing for a
> coding agent, out loud: you hear their voice, you see their screen, and you receive labeled
> screenshots ([image shot_3]) and on-screen selections ([selection sel_2: …]; an updated
> selection reuses its id, a retracted one must be disregarded). Just before each of your
> turns, a bracketed [transcript seg_N: "…"] message shows the exact transcription the
> compiler will use — reconcile it against what you heard. You never write or rewrite the
> briefing — a separate compiler assembles it verbatim from what they said and attached.
> Each time they pause, respond with AT MOST one or two short spoken sentences, choosing the
> single most useful observation: a transcription that contradicts what they plainly meant
> (say what was transcribed vs. meant — the human can only fix it by saying it again more
> clearly); an ambiguous reference an agent could not resolve ("this slider" — two sliders
> were discussed); something described but never shown (suggest a screenshot) or shown but
> never explained; a missing constraint an agent would need. If nothing needs attention, say
> only "clear so far". Never summarize, never repeat the briefing back, never answer the
> task yourself. You may call read_file to check a file or selection against the actual
> source before flagging it — verify suspicions, don't browse.

## Corrections are spoken (the append-only model)

There is no transcript editor. If the linter (or your own eye on the preview) catches a
mistranscription, **say the correction** — "it's Vite, not beat" — and it becomes new content
the agent reads in context. The event stream is append-only; the preview is a read-only render
of the compiler's accumulator, so what you see is what will be sent, by construction. (A
dedicated cheap cleanup model over the accumulated content is a contemplated future addition;
its interaction with the linter is deliberately not designed yet.)

## Cost notes

Realtime conversational models re-read the session context on **every** response — a lint after
each pause costs proportionally to everything the session has heard and seen so far. The
defaults are chosen accordingly: smart-mode sampling (an untouched screen adds **no** frames at
all), one frame per five seconds at most, a terse persona, one short observation per pause, and
`read_file` capped at 32 KB. The trace's 💰 cards show the per-response spend; the turn's
roll-up appears in the trace list.

Gemini-side note: Gemini Live cannot currently power the *transcription* half (no streaming
input deltas, no transcription-only mode — see the research note in
[Realtime: the Wire](./realtime-vendors.md)), so transcription is OpenAI-streaming in every
tier; `linter: "gemini"` runs only the linter session on Gemini.
