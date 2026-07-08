# Realtime Pivot — First Steps (plan)

> **Status: IMPLEMENTED (July 2026).** All phases landed; see
> [Prompt Linting](../guide/prompt-linting.md) for the shipped feature. This document is the
> plan record.

Status: **plan, not yet implemented** (July 2026). The mechanical, low-risk half of
[Realtime Models as Prompt Linters](./realtime_prompt_linter_design.md): retire automatic
turn-splitting as the default while keeping every piece of infrastructure (worklet, PCM
lanes, the endpointer code itself). The linter persona, tier collapse, and tool-call events
are **out of scope** here — they get their own plan once the design settles.

## Step 1 — gate the silence auto-split (default off)

The ~900 ms endpointer (`shell/talk.ts`: `ENDPOINT_SILENCE_MS`, `startEndpointer`) exists to
make the REST transcription tier feel interactive — pseudo-streaming by chopping a hold into
utterance segments. The pivot's position: that was the wrong trade. Offline STT models are
small and do better with the full utterance context; the realtime tiers stream deltas anyway;
and in the live submode every auto-split is a **billed model turn** at every pause in speech.

- Add `talkAutoSplit: boolean` to `IntentPipelineConfig` (default **`false`** — full talk
  windows everywhere). The endpointer code stays; the config gates it.
- **Scope the gate to the main talk lane only.** The hands-free **correction bar** depends on
  the endpointer to segment utterances into the live line (`startCorrectionListening`) — that
  lane keeps auto-split unconditionally.
- Keep `ENDPOINT_SILENCE_MS` a constant for now; a tunable threshold is a later knob if
  anyone re-enables the split.

### Per-tier effects to accept (and document)

| Tier | Effect of `talkAutoSplit: false` |
| --- | --- |
| `mock` | none observable (tests may pin segment counts — update) |
| `standard`/`premium` (REST) | one blob per talk window; the transcript lands after release — the pseudo-streaming feel is gone, by design |
| `rapid` (realtime STT) | unchanged feel — deltas stream *during* the window regardless of splits |
| `flagship` / live tiers | **fewer, longer turns**: one response opportunity per window instead of one per pause |

Two follow-on notes:

- **Long-blob bounds (REST):** minutes of 24 kHz PCM is a big upload; check the transcriber's
  size limits and add a cap or a warning rather than a silent failure.
- **Live preview latency:** with long windows, live-tier user transcripts arrive at window
  end (Gemini's engine buffers `inputTranscription` fragments until `turnComplete`; OpenAI
  transcribes per committed buffer). The preview will fill in window-sized steps. A later
  refinement can flush Gemini's input fragments incrementally — the wire already delivers
  them mid-window.

## Step 2 — make long windows ergonomic

- Toggle-talk (`talkMode: "toggle"`) becomes the natural companion; confirm the REC
  indicator and the cheat sheet read correctly for long open windows (they should — both are
  state-driven).
- Verify blur handling: window blur already stops all listening; a long open window must end
  cleanly (commit, not discard) on blur. Check `stopAllListening` → `talkEnd` does commit.

## Step 3 — tests and docs

- `talk.test.ts`: existing auto-split cases become `talkAutoSplit: true` cases; add the
  default-path test ("silence does not end the segment; release does").
- Modality tests that implicitly rely on auto-split timing: audit and pin.
- Docs: [Using the Intent Overlay](../guide/intent-overlay.md) "Talking" section (the
  hold-splits-into-segments description becomes conditional), and
  [Realtime Live Mode](../guide/realtime-live.md) "Turns and cost" (the endpointer bullet
  gains "off by default").

## Deliberately NOT in this plan

- Removing the endpointer code, the audio worklet, or either PCM lane — all stay.
- The linter persona / instructions swap, the flagship + `live-openai` tier collapse, linter
  tool calls and their trace events, `submit_intent`'s demotion — design-doc territory,
  planned separately after the design review.
- Correction-lane behavior — unchanged on purpose.

## Risks

- **Correction chunking granularity:** fewer, longer segments mean coarser chunks in the
  correct-mode chunk picker (a chunk is a run of segments). Acceptable; worth a sanity pass
  in the live demo.
- **Muscle memory:** users accustomed to pause-and-it-transcribes will now hold/toggle
  through whole thoughts. The cheat sheet and tier strip copy should reflect the new rhythm.
