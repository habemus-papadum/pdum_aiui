# aiui intent workbench — the lab

The multimodal intent layer — voice, pen, screenshots, component location, the correction
meta-loop — was **prototyped here and has graduated**: the pipeline lives in
`@habemus-papadum/aiui-dev-overlay` (`intent-pipeline` + `multimodal` + `debug-ui`), the lowering
runs in the channel, and the intent overlay is the shipping default. What remains here is the
**lab**: the same pipeline, imported source-first, mounted on an instrumented page against
self-annotated scenery, plus the mocks and dev-proxies the shipping path replaces with the
channel. Its charter is narrow:

- **latency / accuracy measurement** — the `bench/` harness and the timing pane;
- **pipeline-config research** — every knob of `IntentPipelineConfig` is a toggle, settled by use;
- **fixture capture** — real interaction streams exported to `fixtures/`, the regression net for
  the extracted pipeline and the channel processor;
- **offline UI iteration** — the whole loop runs on mocks, no channel, no keys.

*How to **use** the intent overlay lives in the guide ([docs/guide/intent-overlay.md](../../../docs/guide/intent-overlay.md)).
This lab's docs are about how to **measure and tune** it.*

Private, never published. Its own workspace member (`@habemus-papadum/aiui-workbench`) inside the
overlay package's folder.

## Run

```sh
pnpm workbench      # from the repo root (alias for: pnpm --filter @habemus-papadum/aiui-workbench dev)
```

Open the printed URL in **Chrome**. For real transcription/correction, put `OPENAI_API_KEY=sk-…`
in the repo-root `.env.dev` (gitignored; wins over a shell export). Everything works without a
key — the default transcriber and corrector are mocks.

**Evaluating the UI? Start with the [turn-flow guide](./docs/turn-flow.md)** — how to run each
scenario, what's real vs simulated, and the toggle/measurement walkthrough.

## Scripts

| Command | What |
| --- | --- |
| `pnpm dev` | the lab page (vite; `/api/transcribe`, `/api/chat`, `/api/shot`, `/api/preview` dev-server endpoints) |
| `pnpm test` | vitest — the `bench/` unit tests (the pipeline's own tests moved to the overlay; the fixtures replay there too) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm bench` | the standalone transcription benchmark (no GUI; see the [audio-stack notes](./docs/openai-audio-stack.md)) |

## What the lab keeps vs. imports

The pipeline is a workspace dependency, resolved to **source** (editable installs — edit the
overlay, the lab picks it up with no build step). The lab owns only its scaffolding:

| Lab file | What it owns |
| --- | --- |
| `src/main.ts` | wires the page: scenery + the overlay's multimodal surfaces + the `intent-pipeline` engine/keymap + the shared debug panes + the settings drawer; exposes `window.__wb` for fixture capture / headless driving |
| `src/transcribe.ts` | the lab's **`openai`** transcriber (dev-proxy `/api/transcribe`) — the seam + `mock` are the overlay's; the shipping `openai` path runs channel-side |
| `src/correct.ts` | the lab's **`openai`** corrector (dev-proxy `/api/chat`) — the seam, `mock`, and `SYSTEM_PROMPT` are the overlay's |
| `src/scenery.ts` | the app-under-test, self-annotated with `data-cell` / `data-source-loc` the way the locator vite plugin stamps a real app |
| `src/settings.ts` | the toggle drawer, editing `IntentPipelineConfig` (localStorage-persisted; `WorkbenchSettings` is an alias) |
| `src/styles.ts` | the lab chrome (scenery, HUD, dock frame, settings); the panes ship `aiui-dbg-*`, the multimodal layer ships `mm-*` |
| `bench/transcribe-bench.ts` | say-synthesized latency/RTF/WER benchmark across models (+ a planned corpus runner — see the audio-stack notes) |
| `fixtures/` | captured interaction event-streams; replayed by the overlay's `intent-pipeline/fixtures.test.ts` |
| `vite.config.ts` | dev server + `/api/*` endpoints (`.env.dev` loading, transcription/chat proxies, shot persistence, path previews) |

| Imported from the overlay | What it provides |
| --- | --- |
| `…/intent-pipeline` | `Engine`, the keymap, `composeIntent`, the V4A patch machinery, `IntentPipelineConfig` |
| `…` (main entry, `multimodal`) | `Ink`, `ShotTool`, `AudioCapture`, `Preview`, `locateComponents`, the `mock` transcriber/corrector, `SYSTEM_PROMPT`, `MULTIMODAL_STYLES`, the seam types |
| `…/debug-ui` | `EventPanes` + `engineSource` — the events / IR / timing panes and JSON export, shared with the DevTools extension |

## Docs

- **[The turn flow — an evaluator's guide](./docs/turn-flow.md)**: run it, what's real vs
  simulated, the toggle table, the measurement walkthrough. (How to *use* the overlay is the
  [guide page](../../../docs/guide/intent-overlay.md); this is how to *evaluate* it.)
- **[The OpenAI audio stack](./docs/openai-audio-stack.md)**: the model-choice question — the
  L0→L3 sophistication ladder, cost framing, silence gating, keyword priming, audio-back, and
  the evaluation-corpus/model-lab plan. Includes the first benchmark results.
- **[Open questions & graduation criteria](./docs/open-questions.md)**: the scoreboard — what
  graduated (P0–P5) and what's still open (T1–T7, pending dogfooding).
- **[Field notes](./docs/field-notes.md)**: the engineering residue — the correction
  micro-pipeline (and its two instruction modes), why selection beat the lasso, the
  typing-guard truths, browser/API gotchas, key handling.
