# Interaction fixtures

Real interaction event-streams, captured from the workbench, that pin the intent
pipeline's behaviour. Each `*.json` is exactly what the inspector's **export**
button produces: the engine's append-only `IntentEvent[]` for one session (see
`../src/../../src/intent-pipeline/types.ts`). They are the regression net for the
pipeline extraction (P1) and, later, the channel lowering processor (P2) — replayed
through `composeIntent` in `packages/aiui-dev-overlay/src/intent-pipeline/fixtures.test.ts`.

**Contract reminder** (see `../docs/field-notes.md`): these event shapes *are* the
wire format, and segments-as-lines is the document shape `composeIntent` and the
corrector share. If a fixture stops replaying, a contract drifted — fix the pass,
don't rewrite the fixture.

## The fixtures

| File | What it is |
| --- | --- |
| `plain-dictation.json` | Two clean dictation segments, then send. The baseline turn: `armed → thread-open(talk) → talk×2 → thread-close(send)`. |
| `dictation-typed-correction.json` | One dictation segment with mock typos ("base line", "curb", "ember"), then a **typed** correction ("base line" → "baseline") under `replace` policy — carries a real V4A `patch`. Ends in send. |
| `ink-and-region-shot.json` | An ink stroke over the SpectrumPlot plus a **degraded region shot** — real rect + located components (`SpectrumPlot`, `AppShell`), no `thumb`/`path` because no capture was granted. This is the no-pixels shape worth locking in. Ends in send. |
| `full-turn-send.json` | A full multimodal turn: dictation → region shot → dictation, interleaved (`items = [text, shot, text]`), ending in send. |
| `cancel-turn.json` | A dictation segment then **Esc**: `thread-close(reason: "cancel")`, engine stays armed. |

## Capture method

All five were driven against the **real** workbench dev server (`pnpm dev --port 5183`)
by dispatching synthetic `KeyboardEvent`/`PointerEvent`s through the real keymap →
transcriber (mock) → engine → compose, via the chrome-devtools MCP, and grabbing
`window.__wb.engine.events` (the same array the export button serializes). Not
hand-composed. Two accommodations for headless driving, none of which touch event
fidelity:

- **`getUserMedia` / `getDisplayMedia` stubbed to reject** — the documented "no mic /
  no capture grant" degraded path (`../docs/field-notes.md`). The mock transcriber
  ignores audio, so transcript text is unchanged; shots land in their degraded
  (no-pixels) shape, which is exactly what fixture 3 is meant to capture.
- **Region shots stub only the veil's `setPointerCapture`** — it is unguarded against
  synthetic pointer ids (a field-notes gotcha); every other step (the rect from the
  drag, the `locateComponents` grid, the degraded `grabThumb`) is the real code path.

The typed correction (fixture 2) drove the real preview end-to-end: native text
`Selection` over the mis-transcribed span → the real `pointerup` → `captureSelection`
→ the real correction input + Enter → the real mock corrector → a real V4A patch.

`at` timestamps are absolute epoch milliseconds (as the export emits them); the
replay tests assert on structure and content, not on timing.
