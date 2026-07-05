# Open questions & graduation criteria

*The scoreboard: what the workbench still has to settle, and how a hypothesis gets promoted out
of it. The [turn-flow guide](./turn-flow.md) is how to evaluate; the
[audio-stack notes](./openai-audio-stack.md) own the model-choice questions (their Q1–Q6).*

## Interaction-design questions (settled by use)

Each maps to a toggle in the settings drawer — see the
[toggle table](./turn-flow.md#the-toggles-and-the-question-each-one-answers).

| # | Question | Current hypothesis | Status |
| - | --- | --- | --- |
| T1 | Hold-to-talk or toggle? | Hold — walkie-talkie muscle memory, and PTT release doubles as the REST segment boundary | default; needs dogfooding |
| T2 | Does ink fade or persist? | Fade (~6 s) — annotations are gestures; a screenshot is how you keep one | default; needs dogfooding |
| T3 | Explicit send only, or silence auto-end? | Explicit Enter; auto-end will misfire on thinking pauses | auto-end ships off; try 5–8 s |
| T4 | Does a correction rewrite or annotate? | Replace — the transcript should end up *right*; `note` defers to a smarter lowering model | both implemented; compare S3 |
| T5 | Is the correction meta-loop learnable (select text, speak the fix)? | Yes — it's the workbench's most novel bet | verified mechanically; needs human judgment |
| T6 | Is the ~1–1.5 s REST latency acceptable for the preview? | Borderline — this is what decides the L1 (streaming) spike | needs a live-mic session |
| T7 | Is the LLM diff corrector (~2 s, V4A patch, can fix beyond the selection) worth it over an instant local replace? | Yes when instructions are richer than replacements ("both places", "make it plural") | both wired (`corrector` toggle); needs use |

## Structural questions (need building, not toggling)

- **Thread → channel** — **BUILT (P2).** A multimodal channel format now carries the thread (the
  JSON event log + binary attachment frames), and a lowering processor composes it server-side
  and emits the Option-C body+meta notification — the encoding this bench already matched. The
  lab itself still sends nowhere, by design.
- **Locator in real apps** — **BUILT (P3).** The overlay's `source-locator` vite plugin stamps
  `data-source-loc` / `data-cell` at dev-build time, and the graduated shot locator hit-tests
  those and resolves them against `window.__AIUI__.sourceRoot` to absolute `file:line:col`. The
  scenery here hand-writes the same stamps to keep the lab faithful.
- **Silence gating** (condition pass) and **keyword priming**: typed as optional groups in
  `IntentPipelineConfig` (shipped without UI) and specced in the
  [audio-stack notes](./openai-audio-stack.md); the pass *slots* exist, the passes are stubs.
- **Audio-back ack** (L2): prototype behind a setting once wired; the open UX question is
  barge-in — does a spoken ack collide with the human continuing to talk?
- **Multi-monitor / scrolling**: shots capture the tab viewport; ink coordinates are
  viewport-relative and don't survive scrolling. Fine for a bench; not for shipping.
- **Touch & stylus**: the pen story is mouse-tested only.

## Graduation criteria (what "done designing" looks like)

A gesture/policy moves out of the workbench when:

1. it survives a week of dogfooding without its setting being touched;
2. its event shapes stop changing;
3. its IR pass has fixtures exported from real use (the inspector's export button).

Then: the modality goes into `aiui-dev-overlay` (widget + protocol frames), the pass into the
channel's processors with the fixtures as tests, and the locator annotations become a real vite
plugin.

**This graduation has now happened (P0–P5):** the pipeline, modality, debug UI, channel format,
and locator plugin all landed, with the exported fixtures as the regression net. What's left is
the *design* verdict — the **T1–T7 questions above stay open pending real dogfooding** (the
structural work being done doesn't settle whether hold-to-talk, ~1.5 s REST latency, or the
~2 s LLM corrector are the right calls). The lab's job now is to answer them.
