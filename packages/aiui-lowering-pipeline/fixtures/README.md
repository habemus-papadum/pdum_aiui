# Interaction fixtures

Real interaction event-streams (captured from the since-retired workbench lab) that pin the intent
pipeline's behaviour. Each `*.json` is exactly what the inspector's **export**
button produces: the engine's append-only `IntentEvent[]` for one session (see
`../src/intent-pipeline/types.ts`). They are the regression net for the
pipeline extraction (P1) and, later, the channel lowering processor (P2) — replayed
through `composeIntent` in `packages/aiui-dev-overlay/src/intent-pipeline/fixtures.test.ts`.

**Contract reminder** (see `archive/workbench/field-notes.md` at the repo root): these event shapes *are* the
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

## Streaming (realtime) wire fixtures — `streaming/`

The five fixtures above are pure `IntentEvent[]` streams replayed through `composeIntent`. The
**realtime transcriber** (streaming-turns.md §3) introduces a different shape: an *ordered wire
sequence* of interleaved client frames (`events` batches + streamed `audio` frames) and the
server's delta→delta→final echoes. Those live under `streaming/` (a subdirectory, so the
`composeIntent` replay in `intent-pipeline/fixtures.test.ts` — which globs only this directory's
top-level `*.json` — is unaffected) and are replayed by the channel's `realtime.test.ts`.

| File | What it is |
| --- | --- |
| `streaming/realtime-turn.json` | One `openai-realtime` dictation turn on the wire: `armed → thread-open → talk-start`, three `audio` frames carrying `seg_1`'s PCM in `seq` order, `talk-end` (the commit boundary), then the upstream `…delta`/`…completed` echoes, then a bare `fin`. Pins the streaming contract — audio streams *during* talk under the PTT boundaries, and the partial deltas must **not** change what the turn commits (only the `…completed` final composes). |

## Capture method (historical — the workbench lab has since been retired)

All five were driven against the **real** workbench dev server (`pnpm dev --port 5183`)
by dispatching synthetic `KeyboardEvent`/`PointerEvent`s through the real keymap →
transcriber (mock) → engine → compose, via the chrome-devtools MCP, and grabbing
`window.__wb.engine.events` (the same array the export button serializes). Not
hand-composed. Two accommodations for headless driving, none of which touch event
fidelity:

- **`getUserMedia` / `getDisplayMedia` stubbed to reject** — the documented "no mic /
  no capture grant" degraded path (`archive/workbench/field-notes.md`). The mock transcriber
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
