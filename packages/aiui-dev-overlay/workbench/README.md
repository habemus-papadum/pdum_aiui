# aiui intent workbench

The design bench for the **rich multimodal intent layer** — voice, pen, screenshots, component
location, and the correction meta-loop — one instrumented page where interaction-design choices
are settings, every action is an event on one stream, and the IR passes re-run live. What
survives dogfooding here graduates into `aiui-dev-overlay` + the channel; exported event JSON
becomes the fixtures the real passes are tested against.

Private, never published. Part of the `@habemus-papadum/aiui-dev-overlay` package's folder but
its own workspace member (`@habemus-papadum/aiui-workbench`).

## Run

```sh
pnpm workbench      # from the repo root (alias for: pnpm --filter @habemus-papadum/aiui-workbench dev)
```

Open the printed URL in **Chrome**. For real transcription, put `OPENAI_API_KEY=sk-…` in the
repo-root `.env.dev` (gitignored; wins over a shell export). Everything works without a key —
the default transcriber is a mock.

**Evaluating the UI? Start with the [turn-flow guide](./docs/turn-flow.md)** — how to run each
scenario, what's real vs simulated, and what every toggle is for.

## Scripts

| Command | What |
| --- | --- |
| `pnpm dev` | the workbench page (vite; `/api/transcribe`, `/api/shot`, `/api/preview` dev-server endpoints) |
| `pnpm test` | vitest — engine/keymap/bench unit tests |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm bench` | the standalone transcription benchmark (no GUI; see the [audio-stack notes](./docs/openai-audio-stack.md)) |

## Source map

| File | What it owns |
| --- | --- |
| `src/engine.ts` | the event stream + state machine (armed/mode/talking/thread) and `composeIntent`, the first IR pass (pure, tested) |
| `src/keymap.ts` | the minimalist keymap; decision logic is pure and tested |
| `src/ink.ts` | the pen canvas: strokes, fade, clear, freeze-into-screenshot |
| `src/shot.ts` | region/viewport capture (one-time tab grant), the component locator (`[data-source]` hit-testing) |
| `src/audio.ts` | mic stream, per-segment MediaRecorder, level meter |
| `src/transcribe.ts` | the `Transcriber` seam: mock (streaming, injectable typos) + OpenAI REST via the dev-server proxy |
| `src/preview.ts` | the transcript popup: streaming text, inline thumbnails, selection-based correction targeting, the diff flash |
| `src/patch.ts` | V4A (`apply_patch`) subset: context-anchored patch apply + the word-level diff for the flash |
| `src/correct.ts` | the correction micro-pipeline seam: mock (local patch) + openai (LLM emits the patch via `/api/chat`) |
| `src/inspector.ts` | events / IR / timing panes + JSON export; Option-C path rows with hover previews |
| `src/settings.ts` | the toggle drawer (localStorage-persisted) |
| `src/scenery.ts` | the app-under-test, self-annotated the way a locator vite plugin would |
| `bench/transcribe-bench.ts` | say-synthesized latency/RTF/WER benchmark across models |
| `vite.config.ts` | dev server + `/api/*` endpoints (`.env.dev` loading, transcription proxy, shot persistence, path previews) |

## Docs

- **[The turn flow — an evaluator's guide](./docs/turn-flow.md)**: run it, what's implemented
  and wired (and what's simulated), the toggle table, a full evaluation walkthrough.
- **[The OpenAI audio stack](./docs/openai-audio-stack.md)**: the model-choice question — the
  L0→L3 sophistication ladder, cost framing, silence gating, keyword priming, audio-back, and
  the evaluation-corpus/model-lab plan. Includes the first benchmark results.
- **[Open questions & graduation criteria](./docs/open-questions.md)**: what's still unsettled,
  and how a design hypothesis gets promoted out of the workbench.
- **[Field notes](./docs/field-notes.md)**: the engineering residue — the correction
  micro-pipeline (and its two instruction modes), why selection beat the lasso, the
  typing-guard truths, browser/API gotchas, key handling.
